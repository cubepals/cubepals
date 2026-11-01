# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

"""Verify reporter JaCoCo and PIT evidence without executing the proposed build configuration.

Coverage includes every Java source, and compares the current report with independently measured
base evidence. New or changed production files must meet branch/method/line floors. Mutation
scores are per source file; only killed mutants count, and inconclusive outcomes fail closed.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import xml.etree.ElementTree as ET


SOURCE_ROOT = Path("apps/reporter/src/main/java")
FLOORS = {"BRANCH": 80, "METHOD": 90, "LINE": 90}
MUTATION_FLOOR = 80


def git(root, *args):
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout


def verify_checkout(root, head):
    """Match files to committed blobs, including executable bits, without trusting index flags."""
    directories = {root}
    for record in git(root, "ls-tree", "-r", "-z", head).split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        mode, kind, oid = metadata.split(" ")
        if (kind != "blob" or mode not in {"100644", "100755", "120000"}
                or not re.fullmatch(r"[a-f0-9]{40}", oid)
                or name.startswith("/") or any(part in {"", ".."} for part in name.split("/"))):
            raise ValueError(f"unsupported committed reporter input: {name}")
        path = root / name
        directory = path.parent
        while directory not in directories:
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError(f"head input traverses a non-directory or symlink: {name}")
            directories.add(directory)
            directory = directory.parent
        info = path.lstat()
        if mode == "120000" and stat.S_ISLNK(info.st_mode):
            data = os.fsencode(os.readlink(path))
        elif mode in {"100644", "100755"} and stat.S_ISREG(info.st_mode):
            if bool(info.st_mode & 0o111) != (mode == "100755"):
                raise ValueError(f"working tree differs from authoritative head: {name}")
            data = path.read_bytes()
        else:
            raise ValueError(f"head input is not its committed file type: {name}")
        actual = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        if actual != oid:
            raise ValueError(f"working tree differs from authoritative head: {name}")
    if git(root, "ls-files", "--others", "--exclude-standard", "-z"):
        raise ValueError("untracked inputs cannot receive committed reporter evidence")


def authoritative_changes(root, changed_path, base_sha, head_sha, comparison_path=None):
    """Evidence files are consistency checks; protected workflow arguments supply authority."""
    if not all(re.fullmatch(r"[a-f0-9]{40}", value or "") for value in (base_sha, head_sha)):
        raise ValueError("reporter checks require authoritative --base-sha and --head-sha commit SHAs")
    comparison_path = Path(comparison_path) if comparison_path else Path(changed_path).with_name("comparison.json")
    if not comparison_path.is_file():
        raise ValueError("missing comparison evidence for the authoritative base and head")
    comparison = json.loads(comparison_path.read_text())
    if not isinstance(comparison, dict) or comparison.get("base") != base_sha or comparison.get("head") != head_sha:
        raise ValueError("comparison evidence differs from authoritative --base-sha or --head-sha")
    if base_sha == head_sha:
        raise ValueError("a reporter comparison cannot use the proposed head as its base")
    root = root.resolve()
    if git(root, "rev-parse", "--verify", "HEAD^{commit}").strip() != head_sha:
        raise ValueError("checkout does not match authoritative --head-sha")
    try:
        git(root, "merge-base", "--is-ancestor", base_sha, head_sha)
    except subprocess.CalledProcessError as error:
        raise ValueError("reporter base must be an ancestor of the proposed head") from error
    actual = sorted(filter(None, git(root, "diff", "--name-only", "--no-renames", "--no-ext-diff",
                                    "-z", base_sha, head_sha, "--").split("\0")))
    supplied = json.loads(Path(changed_path).read_text())
    if (not isinstance(supplied, list) or any(not isinstance(path, str) for path in supplied)
            or len(set(supplied)) != len(supplied) or sorted(supplied) != actual):
        raise ValueError("changed files do not match the complete base-to-head Git diff")
    verify_checkout(root, head_sha)
    return actual


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


def mutations(path, subjects, ranges=None, selection_report=None):
    root = read_xml(path)
    if root.tag != "mutations":
        raise ValueError("expected a PIT mutations report")
    counts = {}
    full_counts = {}
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
        full_counts[name] = full_counts.get(name, 0) + 1
        selected = None if ranges is None else ranges[name]
        line = int(mutant.findtext("lineNumber"))
        if selected is not None and not any(item["start"] <= line <= item["end"] for item in selected):
            continue
        status = mutant.attrib.get("status")
        if status not in {"KILLED", "SURVIVED", "NO_COVERAGE"}:
            failures.append(f"{name}: inconclusive PIT outcome {status}")
        killed, total = counts.get(name, (0, 0))
        counts[name] = (killed + int(status == "KILLED"), total + 1)
    if set(full_counts) != set(subjects):
        failures.append(f"mutation inventory mismatch: missing={sorted(set(subjects) - set(full_counts))}; "
                        f"unexpected={sorted(set(full_counts) - set(subjects))}")
    if not full_counts:
        failures.append("PIT produced no mutants")
    for name, counter in counts.items():
        score = percent(counter)
        if score < MUTATION_FLOOR:
            failures.append(f"{name} mutation: {score:.2f}% < {MUTATION_FLOOR}%")
    if selection_report is not None:
        for name in subjects:
            killed, total = counts.get(name, (0, 0))
            selection_report[name] = {"ranges": None if ranges is None else ranges[name],
                                      "wholeFileTotal": full_counts.get(name, 0),
                                      "selectedTotal": total, "killed": killed,
                                      "score": percent((killed, total)) if total else None}
    return failures


def mutation_ranges(root, base, head, subjects):
    """The verified comparison selects added lines; new files and pure deletions keep full scope."""
    selections = {}
    for name in subjects:
        if not git(root, "--literal-pathspecs", "ls-tree", "--name-only", base, "--", name).strip():
            selections[name] = None
            continue
        patch = git(root, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
                    "--no-renames", "--no-color", "--unified=0", base, head, "--", name)
        selected = []
        for match in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", patch, re.MULTILINE):
            start, count = int(match[1]), int(match[2] or 1)
            if count == 0:
                selected = None
                break
            selected.append({"start": start, "end": start + count - 1})
        selections[name] = selected
    return selections


def scope(changed, root, full=False):
    sources = {str(path.relative_to(root)): path.read_text()
               for path in (root / SOURCE_ROOT).rglob("*.java")}
    # Releases mutate changed production classes. Legacy/config/test impact is audited separately.
    return sorted(sources if full else set(changed) & set(sources))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    cover = commands.add_parser("coverage")
    cover.add_argument("--head", required=True)
    cover.add_argument("--base", required=True)
    mutate = commands.add_parser("mutation")
    mutate.add_argument("--report", required=True)
    mutate.add_argument("--subjects", required=True, help="JSON array of repository-relative Java sources")
    mutate.add_argument("--full", action="store_true")
    select = commands.add_parser("scope")
    select.add_argument("--output", required=True)
    select.add_argument("--full", action="store_true")
    for command in (cover, mutate, select):
        command.add_argument("--changed", required=True, help="JSON array checked against the complete Git diff")
        command.add_argument("--base-sha", required=True, help="comparison SHA from protected workflow context")
        command.add_argument("--head-sha", required=True, help="tested SHA from protected workflow context")
        command.add_argument("--comparison", help="comparison evidence; defaults beside --changed")
        command.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        args.root = args.root.resolve()
        changed = authoritative_changes(args.root, args.changed, args.base_sha, args.head_sha, args.comparison)
        if args.command == "scope":
            selected = scope(changed, args.root, args.full)
            Path(args.output).write_text(json.dumps(selected, indent=2) + "\n")
            print(",".join(str(Path(path).relative_to(SOURCE_ROOT).with_suffix("")).replace("/", ".")
                           for path in selected))
            return 0
        if args.command == "coverage":
            failures, deficits = compare_coverage(args.head, args.base, changed, args.root)
            for deficit in deficits:
                print(deficit)
        else:
            expected = scope(changed, args.root, args.full)
            supplied = json.loads(Path(args.subjects).read_text())
            if (not isinstance(supplied, list) or any(not isinstance(path, str) for path in supplied)
                    or len(set(supplied)) != len(supplied) or sorted(supplied) != expected):
                raise ValueError("mutation subjects differ from authoritative Git scope")
            ranges = None if args.full else mutation_ranges(args.root, args.base_sha, args.head_sha, expected)
            selection_report = {}
            failures = mutations(args.report, expected, ranges, selection_report)
            Path(args.subjects).with_name("mutation-selection.json").write_text(
                json.dumps(selection_report, indent=2) + "\n")
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return int(bool(failures))
    except (OSError, ValueError, KeyError, ET.ParseError, subprocess.CalledProcessError) as error:
        print(f"FAIL invalid reporter quality evidence: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
