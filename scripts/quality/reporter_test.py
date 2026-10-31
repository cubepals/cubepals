# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

"""Adversarial verifier tests: absent files, regressed branches and surviving PIT mutants fail."""

import json
from pathlib import Path
import subprocess
import sys
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


class ReporterProvenanceTest(unittest.TestCase):
    """The real CLI cannot borrow mutable evidence to omit committed source changes."""

    report = ReporterEvidenceTest.report

    @classmethod
    def setUpClass(cls):
        cls.signing = tempfile.TemporaryDirectory(prefix="reporter-fixture-signing-")
        cls.addClassCleanup(cls.signing.cleanup)
        cls.key = Path(cls.signing.name) / "signing-key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(cls.key)],
                       check=True, capture_output=True)
        cls.allowed = Path(cls.signing.name) / "allowed-signers"
        cls.allowed.write_text("quality@example.invalid " + cls.key.with_suffix(".pub").read_text())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="reporter-provenance-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.name = "apps/reporter/src/main/java/blockly/reporter/Queue.java"
        self.source = self.root / self.name
        self.source.parent.mkdir(parents=True)
        self.git("init", "--quiet", "--template=", "-b", "fixture")
        for key, value in {
            "core.hooksPath": "/dev/null", "user.name": "Quality fixture",
            "user.email": "quality@example.invalid", "gpg.format": "ssh",
            "user.signingKey": str(self.key), "gpg.ssh.allowedSignersFile": str(self.allowed),
            "commit.gpgsign": "true",
        }.items():
            self.git("config", key, value)
        (self.root / ".gitignore").write_text("coverage/\n")
        self.source.write_text("class Queue { int value() { return 1; } }\n")
        self.base = self.commit()
        self.source.write_text("class Queue { int value() { return 2; } }\n")
        self.head = self.commit()
        self.evidence = self.root / "coverage"
        self.evidence.mkdir()
        self.changed = self.evidence / "changed.json"
        self.changed.write_text(json.dumps([self.name]))
        self.comparison = self.evidence / "comparison.json"
        self.comparison.write_text(json.dumps({"base": self.base, "head": self.head}))
        self.subjects = self.evidence / "subjects.json"
        self.subjects.write_text(json.dumps([self.name]))
        self.report("coverage/base.xml", 5, 5)
        self.report("coverage/head.xml", 5, 5)
        (self.evidence / "mutations.xml").write_text(
            '<mutations><mutation status="KILLED"><sourceFile>Queue.java</sourceFile>'
            '<mutatedClass>blockly.reporter.Queue</mutatedClass><mutatedMethod>value</mutatedMethod>'
            '<methodDescription>()I</methodDescription><lineNumber>1</lineNumber>'
            '<mutator>PrimitiveReturn</mutator><indexes><index>0</index></indexes></mutation></mutations>')

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, capture_output=True, text=True,
                              check=True).stdout.strip()

    def commit(self):
        self.git("add", "--all")
        self.git("commit", "--quiet", "-S", "-m", "Signed quality fixture")
        sha = self.git("rev-parse", "HEAD")
        self.git("verify-commit", sha)
        return sha

    def run_cli(self, command, anchors=True, base=None, head=None):
        arguments = {
            "scope": ["--output", str(self.subjects)],
            "coverage": ["--head", str(self.evidence / "head.xml"),
                         "--base", str(self.evidence / "base.xml")],
            "mutation": ["--report", str(self.evidence / "mutations.xml"), "--subjects", str(self.subjects)],
        }[command]
        return subprocess.run([sys.executable, str(Path(reporter.__file__).resolve()), command,
                               "--root", str(self.root), "--changed", str(self.changed), *arguments,
                               *(["--base-sha", base or self.base, "--head-sha", head or self.head]
                                 if anchors else [])], capture_output=True, text=True)

    def test_verified_git_comparison_selects_the_changed_class(self):
        result = self.run_cli("scope")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("blockly.reporter.Queue", result.stdout.strip())
        self.assertEqual([self.name], json.loads(self.subjects.read_text()))
        result = self.run_cli("mutation")
        self.assertEqual(0, result.returncode, result.stderr)

    def test_changed_file_coverage_floors_cannot_borrow_the_weak_base(self):
        result = self.run_cli("coverage")
        self.assertEqual(1, result.returncode)
        self.assertIn("BRANCH: 50.00% < 80.00%", result.stderr)
        self.assertIn("METHOD: 50.00% < 90.00%", result.stderr)
        self.assertIn("LINE: 50.00% < 90.00%", result.stderr)

    def test_every_cli_rejects_forged_empty_changed_files(self):
        self.changed.write_text("[]")
        for command in ("scope", "coverage", "mutation"):
            with self.subTest(command=command):
                result = self.run_cli(command)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("complete base-to-head Git diff", result.stderr)

    def test_every_cli_requires_authoritative_shas(self):
        for command in ("scope", "coverage", "mutation"):
            with self.subTest(command=command):
                result = self.run_cli(command, anchors=False)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("--base-sha", result.stderr)
                self.assertIn("--head-sha", result.stderr)

    def test_forged_head_as_base_artifact_cannot_override_workflow_authority(self):
        self.comparison.write_text(json.dumps({"base": self.head, "head": self.head}))
        self.changed.write_text("[]")
        for command in ("scope", "coverage"):
            with self.subTest(command=command):
                result = self.run_cli(command)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("comparison evidence differs from authoritative", result.stderr)

    def test_head_as_base_is_rejected_even_with_matching_artifacts(self):
        self.comparison.write_text(json.dumps({"base": self.head, "head": self.head}))
        self.changed.write_text("[]")
        result = self.run_cli("scope", base=self.head)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("proposed head as its base", result.stderr)

    def test_missing_comparison_evidence_does_not_fall_back_to_mutable_inputs(self):
        self.comparison.unlink()
        result = self.run_cli("scope")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("missing comparison evidence", result.stderr)

    def test_a_different_checkout_cannot_borrow_comparison_metadata(self):
        self.source.write_text("class Queue { int value() { return 3; } }\n")
        self.commit()
        for command in ("scope", "coverage"):
            with self.subTest(command=command):
                result = self.run_cli(command)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("checkout does not match authoritative", result.stderr)

    def test_dirty_source_is_rejected_even_when_the_index_hides_the_change(self):
        self.git("update-index", "--assume-unchanged", self.name)
        self.source.write_text("class Queue { int value() { return 99; } }\n")
        result = self.run_cli("scope")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("working tree differs from authoritative head", result.stderr)

    def test_untracked_java_inputs_cannot_use_committed_evidence(self):
        self.source.with_name("Unexpected.java").write_text("class Unexpected {}\n")
        result = self.run_cli("scope")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("untracked inputs", result.stderr)

    def test_post_pit_subject_artifacts_cannot_omit_changed_classes(self):
        self.subjects.write_text("[]")
        result = self.run_cli("mutation")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("mutation subjects differ from authoritative Git scope", result.stderr)


if __name__ == "__main__":
    unittest.main()
