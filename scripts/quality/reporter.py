# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

"""Verify reporter JaCoCo and PIT evidence without executing the proposed build configuration.

Coverage includes every Java source, and compares the current report with independently measured
base evidence. New or changed production files must meet branch/method/line floors. Mutation
scores are per source file; only killed mutants count, and inconclusive outcomes fail closed.
"""

import argparse
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET


SOURCE_ROOT = Path("apps/reporter/src/main/java")
FLOORS = {"BRANCH": 80, "METHOD": 90, "LINE": 90}
MUTATION_FLOOR = 80


def read_xml(path):
    text = Path(path).read_text()
    # JaCoCo emits its public report DTD; ElementTree does not resolve external entities.
    if "<!ENTITY" in text:
        raise ValueError("entity declarations are not quality evidence")
    return ET.fromstring(text)


def coverage(path):
    root = read_xml(path)
    if root.tag != "report":
        raise ValueError("expected a JaCoCo report")
    files = {}
    for package in root.findall("package"):
        package_name = package.attrib["name"]
        for source in package.findall("sourcefile"):
            name = str(SOURCE_ROOT / package_name / source.attrib["name"])
            if name in files:
                raise ValueError(f"duplicate coverage file: {name}")
            counters = {}
            for counter in source.findall("counter"):
                kind = counter.attrib["type"]
                if kind not in FLOORS:
                    continue
                if kind in counters:
                    raise ValueError(f"duplicate {kind} counter for {name}")
                missed, covered = int(counter.attrib["missed"]), int(counter.attrib["covered"])
                if min(missed, covered) < 0:
                    raise ValueError(f"negative {kind} counter for {name}")
                counters[kind] = (covered, covered + missed)
            if not {"LINE", "METHOD"}.issubset(counters):
                raise ValueError(f"missing executable coverage counters for {name}")
            if any(counters[kind][1] == 0 for kind in ("LINE", "METHOD")):
                raise ValueError(f"empty executable coverage counters for {name}")
            # JaCoCo omits BRANCH when a source contains no decision points.
            files[name] = {kind: counters.get(kind, (0, 0)) for kind in FLOORS}
    if not files:
        raise ValueError("JaCoCo report contains no source files")
    return files


def percent(counter):
    covered, total = counter
    return covered * 100 / total if total else 100


def compare_coverage(head_path, base_path, changed, root):
    current, previous = coverage(head_path), coverage(base_path)
    expected = {str(path.relative_to(root)) for path in (root / SOURCE_ROOT).rglob("*.java")}
    if set(current) != expected:
        raise ValueError(f"coverage inventory mismatch: missing={sorted(expected - set(current))}; "
                         f"unexpected={sorted(set(current) - expected)}")
    missing_base = set(current) - set(previous) - set(changed)
    missing_head = set(previous) - set(current) - set(changed)
    if missing_base or missing_head:
        raise ValueError(f"source inventory changed without a source change: {sorted(missing_base | missing_head)}")
    failures, deficits = [], []
    for name, counters in current.items():
        for kind, counter in counters.items():
            actual = percent(counter)
            baseline = percent(previous[name][kind]) if name in previous else 0
            if name in previous and name not in changed and counter[1] != previous[name][kind][1]:
                failures.append(f"{name} {kind}: inventory changed without a source change")
            if name in previous:
                previous_covered, previous_total = previous[name][kind]
                if counter[1] - counter[0] > previous_total - previous_covered:
                    failures.append(f"{name} {kind}: uncovered elements increased")
            required = max(baseline, FLOORS[kind]) if name in changed or name not in previous else baseline
            if actual + 1e-9 < required:
                failures.append(f"{name} {kind}: {actual:.2f}% < {required:.2f}%")
            if actual < FLOORS[kind]:
                deficits.append(f"{name} {kind}: {actual:.2f}% (legacy floor deficit)")
    return failures, deficits


def mutations(path, subjects):
    root = read_xml(path)
    if root.tag != "mutations":
        raise ValueError("expected a PIT mutations report")
    counts = {}
    failures = []
    identities = set()
    for mutant in root.findall("mutation"):
        source = mutant.findtext("sourceFile")
        class_name = mutant.findtext("mutatedClass")
        if not source or not class_name:
            raise ValueError("PIT mutant lacks its source or class")
        parts = [mutant.findtext(key) for key in ("mutatedMethod", "methodDescription", "lineNumber", "mutator")]
        indexes = tuple(index.text for index in mutant.findall("indexes/index"))
        if not all(parts) or not indexes or any(index is None for index in indexes):
            raise ValueError("PIT mutant lacks its mutation identity")
        identity = (class_name, *parts, indexes)
        if identity in identities:
            raise ValueError("duplicate PIT mutation identity")
        identities.add(identity)
        name = str(SOURCE_ROOT / class_name.rsplit(".", 1)[0].replace(".", "/") / source)
        status = mutant.attrib.get("status")
        if status not in {"KILLED", "SURVIVED", "NO_COVERAGE"}:
            failures.append(f"{name}: inconclusive PIT outcome {status}")
        killed, total = counts.get(name, (0, 0))
        counts[name] = (killed + int(status == "KILLED"), total + 1)
    if set(counts) != set(subjects):
        failures.append(f"mutation inventory mismatch: missing={sorted(set(subjects) - set(counts))}; "
                        f"unexpected={sorted(set(counts) - set(subjects))}")
    if not counts:
        failures.append("PIT produced no mutants")
    for name, counter in counts.items():
        score = percent(counter)
        if score < MUTATION_FLOOR:
            failures.append(f"{name} mutation: {score:.2f}% < {MUTATION_FLOOR}%")
    return failures


def scope(changed, root, full=False):
    sources = {str(path.relative_to(root)): path.read_text()
               for path in (root / SOURCE_ROOT).rglob("*.java")}
    if full or any(path.endswith(("gradle.properties", "gradle.lockfile", "libs.versions.toml"))
                   or path.startswith("apps/reporter/src/main/resources/")
                   or (path.startswith("apps/reporter/src/test/") and not path.endswith(".java"))
                   or path.startswith("apps/reporter/gradle/") for path in changed):
        return sorted(sources)
    names = {path: Path(path).stem for path in sources}

    def references(text):
        return {path for path, name in names.items() if re.search(r"\b" + re.escape(name) + r"\b", text)}

    selected = set(changed) & set(sources)
    for path in changed:
        if path.startswith("apps/reporter/src/test/") and path.endswith(".java"):
            test = root / path
            # A removed or unfamiliar test might have held any class's only defect detector.
            if not test.is_file():
                return sorted(sources)
            found = references(test.read_text())
            if not found:
                return sorted(sources)
            pending = set(found)
            visited = set()
            while pending:
                source = pending.pop()
                if source in visited:
                    continue
                visited.add(source)
                selected.add(source)
                pending.update(references(sources[source]) - visited)
    return sorted(selected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    cover = commands.add_parser("coverage")
    cover.add_argument("--head", required=True)
    cover.add_argument("--base", required=True)
    cover.add_argument("--changed", required=True, help="JSON array of repository-relative paths")
    cover.add_argument("--root", type=Path, default=Path.cwd())
    mutate = commands.add_parser("mutation")
    mutate.add_argument("--report", required=True)
    mutate.add_argument("--subjects", required=True, help="JSON array of repository-relative Java sources")
    select = commands.add_parser("scope")
    select.add_argument("--changed", required=True)
    select.add_argument("--root", type=Path, default=Path.cwd())
    select.add_argument("--output", required=True)
    select.add_argument("--full", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "scope":
            selected = scope(json.loads(Path(args.changed).read_text()), args.root, args.full)
            Path(args.output).write_text(json.dumps(selected, indent=2) + "\n")
            print(",".join(str(Path(path).relative_to(SOURCE_ROOT).with_suffix("")).replace("/", ".")
                           for path in selected))
            return 0
        if args.command == "coverage":
            failures, deficits = compare_coverage(args.head, args.base, json.loads(Path(args.changed).read_text()), args.root)
            for deficit in deficits:
                print(deficit)
        else:
            failures = mutations(args.report, json.loads(Path(args.subjects).read_text()))
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return int(bool(failures))
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        print(f"FAIL invalid reporter quality evidence: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
