# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

"""Adversarial verifier tests: absent files, regressed branches and surviving PIT mutants fail."""

from pathlib import Path
import tempfile
import unittest

import reporter


class ReporterEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.name = "apps/reporter/src/main/java/blockly/reporter/Queue.java"
        source = self.root / self.name
        source.parent.mkdir(parents=True)
        source.write_text("class Queue {}")

    def report(self, name, covered=10, missed=0):
        path = self.root / name
        path.write_text('<report name="test"><package name="blockly/reporter">'
                        '<sourcefile name="Queue.java">'
                        + ''.join(f'<counter type="{kind}" covered="{covered}" missed="{missed}"/>'
                                  for kind in reporter.FLOORS)
                        + '</sourcefile></package></report>')
        return path

    def test_clean_evidence_passes_and_a_coverage_regression_fails(self):
        baseline = self.report("base.xml")
        passing = self.report("passing.xml")
        self.assertEqual(([], []), reporter.compare_coverage(passing, baseline, [], self.root))
        regression = self.report("regression.xml", 8, 2)
        failures, _ = reporter.compare_coverage(regression, baseline, [], self.root)
        self.assertTrue(any("BRANCH" in failure for failure in failures))
        self.assertTrue(any("METHOD" in failure for failure in failures))
        self.assertTrue(any("LINE" in failure for failure in failures))

    def test_changed_source_must_reach_floors_even_with_a_weak_base(self):
        baseline = self.report("base.xml", 5, 5)
        current = self.report("current.xml", 5, 5)
        failures, _ = reporter.compare_coverage(current, baseline, [self.name], self.root)
        self.assertEqual(3, len(failures))

    def test_unreported_source_cannot_disappear_from_denominator(self):
        report = self.report("report.xml")
        (self.root / self.name).with_name("Uncovered.java").write_text("class Uncovered {}")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            reporter.compare_coverage(report, report, [], self.root)

    def test_missing_counter_is_invalid_evidence(self):
        report = self.report("report.xml")
        report.write_text(report.read_text().replace('<counter type="LINE" covered="10" missed="0"/>', ''))
        with self.assertRaisesRegex(ValueError, "missing executable"):
            reporter.coverage(report)

    def test_mutation_requires_defect_detection_and_rejects_timeout(self):
        path = self.root / "mutations.xml"
        for status, expected in [("KILLED", False), ("SURVIVED", True), ("NO_COVERAGE", True), ("TIMED_OUT", True)]:
            with self.subTest(status=status):
                path.write_text(f'<mutations><mutation status="{status}">'
                                '<sourceFile>Queue.java</sourceFile>'
                                '<mutatedClass>blockly.reporter.Queue</mutatedClass>'
                                '<mutatedMethod>offer</mutatedMethod><methodDescription>()Z</methodDescription>'
                                '<lineNumber>1</lineNumber><mutator>BooleanReturn</mutator>'
                                '<indexes><index>0</index></indexes>'
                                '</mutation></mutations>')
                self.assertEqual(expected, bool(reporter.mutations(path, [self.name])))

    def test_empty_mutation_run_fails(self):
        path = self.root / "mutations.xml"
        path.write_text('<mutations/>')
        self.assertTrue(reporter.mutations(path, [self.name]))

    def test_a_fabricated_killed_count_without_mutation_identity_fails(self):
        path = self.root / "mutations.xml"
        path.write_text('<mutations><mutation status="KILLED"><sourceFile>Queue.java</sourceFile>'
                        '<mutatedClass>blockly.reporter.Queue</mutatedClass></mutation></mutations>')
        with self.assertRaisesRegex(ValueError, "mutation identity"):
            reporter.mutations(path, [self.name])

    def test_adding_covered_code_cannot_hide_new_uncovered_elements(self):
        baseline = self.report("base.xml", 8, 2)
        current = self.report("current.xml", 97, 3)
        failures, _ = reporter.compare_coverage(current, baseline, [self.name], self.root)
        self.assertTrue(any("uncovered elements increased" in failure for failure in failures))

    def test_test_only_changes_include_their_production_dependencies(self):
        dependency = (self.root / self.name).with_name("Events.java")
        dependency.write_text("class Events {}")
        (self.root / self.name).write_text("class Queue { Events events; }")
        test_path = "apps/reporter/src/test/java/blockly/reporter/QueueTest.java"
        test = self.root / test_path
        test.parent.mkdir(parents=True)
        test.write_text("class QueueTest { Queue queue; }")
        self.assertEqual([str(dependency.relative_to(self.root)), self.name], reporter.scope([test_path], self.root))
        self.assertEqual([str(dependency.relative_to(self.root)), self.name],
                         reporter.scope([self.name, test_path], self.root))
        test.unlink()
        self.assertEqual([str(dependency.relative_to(self.root)), self.name], reporter.scope([test_path], self.root))
        self.assertEqual([str(dependency.relative_to(self.root)), self.name], reporter.scope(
            ["apps/reporter/src/test/resources/junit-platform.properties"], self.root))


if __name__ == "__main__":
    unittest.main()
