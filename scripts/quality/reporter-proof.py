# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

"""Run real Java tests, instrumentation and mutation against deliberate defects in a scratch copy.

The production checkout is never edited. Logs and a machine-readable result survive cleanup so
CI proves why each bad revision was rejected, rather than accepting an arbitrary command failure.
"""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import reporter


EVENTS = "apps/reporter/src/main/java/blockly/reporter/Events.java"
QUEUE = "apps/reporter/src/main/java/blockly/reporter/Queue.java"
JACOCO = "apps/reporter/build/reports/jacoco/test/jacocoTestReport.xml"
PIT = "apps/reporter/build/reports/pitest/mutations.xml"


def prove(root, output):
    output.mkdir(parents=True, exist_ok=True)
    (output / "results.json").unlink(missing_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix="reporter-quality-proof-") as temporary:
        scratch = Path(temporary)
        project = scratch / "apps/reporter"
        shutil.copytree(root / "apps/reporter", project, ignore=shutil.ignore_patterns("build", ".gradle"))

        def gradle(label, tasks, expect_success=True):
            print(f"Reporter enforcement proof: {label}", flush=True)
            result = subprocess.run(["./gradlew", *tasks, "--no-daemon", "--console=plain"],
                                    cwd=project, capture_output=True, text=True, timeout=600)
            log = result.stdout + result.stderr
            (output / f"{label}.log").write_text(log)
            if (result.returncode == 0) != expect_success:
                raise RuntimeError(f"{label} had unexpected exit {result.returncode}; see {output / (label + '.log')}")
            return log

        gradle("clean", ["test", "jacocoTestReport", "pitest", "-PqualityClasses=blockly.reporter.Events"])
        baseline = output / "clean-coverage.xml"
        shutil.copyfile(scratch / JACOCO, baseline)
        shutil.copyfile(scratch / PIT, output / "clean-mutations.xml")
        failures, _ = reporter.compare_coverage(scratch / JACOCO, baseline, [], scratch)
        if failures or reporter.mutations(scratch / PIT, [EVENTS]):
            raise RuntimeError("clean evidence must pass before adversarial probes")
        results.append({"case": "clean baseline", "rejected": False})

        queue = scratch / QUEUE
        original_queue = queue.read_text()
        defect = "status >= 200 && status < 300"
        if original_queue.count(defect) != 1:
            raise RuntimeError("HTTP defect probe no longer identifies exactly one decision")
        queue.write_text(original_queue.replace(defect, "status >= 200 && status <= 300"))
        log = gradle("boundary-defect", ["test", "--tests", "blockly.reporter.QueueTest"], False)
        results_xml = project / "build/test-results/test/TEST-blockly.reporter.QueueTest.xml"
        failures = [failure.attrib.get("message", "") for failure in ET.parse(results_xml).iter("failure")]
        if ("httpRequiresSuccessfulStatusAndPreservesTheRequest() FAILED" not in log
                or not any("HTTP status 300" in message and "expected: <false> but was: <true>" in message
                           for message in failures)):
            raise RuntimeError("the defect must fail its HTTP contract assertion, not infrastructure")
        results.append({"case": "HTTP upper-bound defect", "rejected": True})
        queue.write_text(original_queue)

        events = scratch / EVENTS
        original_events = events.read_text()
        prefix, suffix = original_events.rsplit("}", 1)
        events.write_text(prefix + "    static boolean qualityProbe(int n) {\n"
                          "        if (n <= 0) return false;\n"
                          "        return n > 10;\n    }\n}" + suffix)
        gradle("uncovered-code", ["test", "jacocoTestReport"])
        failures, _ = reporter.compare_coverage(scratch / JACOCO, baseline, [EVENTS], scratch)
        if not any(EVENTS in failure for failure in failures):
            raise RuntimeError("the uncovered method and decisions were not rejected")
        (output / "uncovered-code-rejection.json").write_text(json.dumps(failures, indent=2) + "\n")
        results.append({"case": "uncovered branch/function/line", "rejected": True})
        events.write_text(original_events)

        weak_test = project / "src/test/java/blockly/reporter/EventsTest.java"
        weak_test.write_text('''package blockly.reporter;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.List;
class EventsTest {
    @Test void executesWithoutCheckingBehavior() {
        Events.event("login", Instant.EPOCH, null, null, null);
        Events.batch(List.of());
        Events.tick(20, 0, 0);
        Events.address(null);
    }
}
''')
        gradle("weak-tests", ["test", "pitest", "-PqualityClasses=blockly.reporter.Events"])
        failures = reporter.mutations(scratch / PIT, [EVENTS])
        if not any(EVENTS in failure and "mutation:" in failure for failure in failures):
            raise RuntimeError("tests without behavioral assertions were not rejected by mutation score")
        (output / "weak-tests-rejection.json").write_text(json.dumps(failures, indent=2) + "\n")
        results.append({"case": "tests without assertions", "rejected": True})

        prefix, suffix = weak_test.read_text().rsplit("}", 1)
        weak_test.write_text(prefix + "    @Test @org.junit.jupiter.api.Disabled\n"
                             "    void skippedContract() {}\n}" + suffix)
        log = gradle("skipped-tests", ["test"], False)
        if "Reporter tests must not skip or abort cases" not in log:
            raise RuntimeError("the disabled test must fail the skipped-test gate")
        results.append({"case": "disabled test", "rejected": True})
    (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, default=Path("coverage/reporter-proof"))
    args = parser.parse_args()
    try:
        print(json.dumps(prove(args.root.resolve(), args.output.resolve()), indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"FAIL reporter enforcement proof: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
