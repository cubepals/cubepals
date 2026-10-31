<!-- SPDX-FileCopyrightText: 2026 The Cubepals Authors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Quality policy trust boundary

`quality-policy.yml` reads the controller from the pull request's base commit and reads proposed
files as Git objects. It does not install packages, import modules, follow proposed symlinks, or
run scripts from the proposed tree. A separate job publishes `Quality policy` on the exact head
commit. Failure, cancellation, and an unexpectedly skipped controller publish failure.
PR edits rerun the policy check, including changes to the target branch.

`policy.mjs` protects the quality controller, workflows, ownership file, test configuration,
reporter Gradle configuration and wrapper, and test/quality package commands. Quality dependency
versions, resolution records, integrity hashes, and their transitive graph are protected too.
Unrelated dependency updates may change `bun.lock`; changes to a dependency shared with a quality
tool require a policy update. New skip/focus modifiers and coverage/mutation suppression comments
are refused. Existing conditional skips are frozen by expression and occurrence count.
Reporter test annotations that disable or conditionally enable a case, and JUnit assumptions,
cannot be introduced through an ordinary PR.
New direct references to coverage counters, active mutant identifiers, and quality evidence
locations are also refused outside protected infrastructure, including quoted property names.

The lexical scan catches ordinary exclusion, test-disabling, and evidence-aware changes. It is not a JavaScript
security sandbox or proof that an arbitrary program is honest. Executable tests can inspect or
forge their own process state. Coverage, mutation, invariant tests, strict evidence validation,
and the policy guard provide complementary evidence, not a proof of all possible behavior.

## Incremental test obligations and legacy code

New and changed production files must meet their per-file coverage floors and the 80% mutation
floor. Existing files retain measured coverage through a non-regression ratchet. The initial
complete hosted measurement covered 1,163 source files: 715 had 1,675 legacy metric deficits
(605 branch, 566 function, and 504 line deficits). Those deficits are visible debt, not evidence
that the files satisfy the new floors. The first complete comparison rejected 11 regressed
metrics across six unchanged files. Deterministic failure-path tests address the missing evidence;
the audit and seeded mutations did not establish an existing production defect.

For JavaScript and TypeScript, `test-impact.mjs` verifies the complete Git comparison and
working-tree input hashes. The mutation CLI also binds that comparison to the authoritative
base and head SHAs passed directly by the protected workflow. A new,
regular executable test file can be classified separately from changes to existing tests. This
does not retrospectively require every legacy module imported by a large integration harness
to meet the mutation floor merely because another test was added. The runner executes original,
identical tests first using the baseline run's `base/manifests/GROUP.json` path/hash manifest.
Each file has an isolated Bun module realm; added or modified tests run in a later process.
The parent validates and retains original-test evidence before that later process starts. Tracked
source, tests, fixtures, and configuration must match their input snapshot after each phase.
This prevents additions from replacing the original test evidence. It is not an operating-system
sandbox. The Java reporter continues to use class-based PIT selection for its test changes.

The classification never removes independent obligations. Changed production remains a mutation
subject. Dependency and runner-configuration changes retain conservative scope, except when
`config-impact.mjs` proves application dependency resolution unchanged. Renaming, deleting, or
replacing an existing test cannot claim addition status. Edited tests retain the union of their
base and proposed dependencies, so deleting an import cannot erase its original subject.
A removed test with a complete, unambiguous, nonempty base dependency map retains those mutation
subjects without expanding to the entire repository. Empty or ambiguous maps retain full scope.
Any test deletion disables additive exemptions for newly named tests, so a renamed replacement
also contributes its proposed dependencies and must still meet the mutation floor.
Changed modules reached only through tests are conservatively treated as potential test support:
their affected tests retain both dependency closures. Assertion-library imports receive the same
treatment. Ambiguous dependency mappings and changed fixture/data inputs expand scope instead
of trusting an unproved mapping. No directory name exempts executable test helpers from coverage
or mutation. Scheduled runs still audit the complete source inventory in stable partitions.

Support classification is conservative graph analysis, not a proof of a function's semantic
role. A function shared by production and tests can also calculate expected results without
importing an assertion library; an import graph cannot distinguish that use from ordinary
application code. Such a changed function still receives the production coverage and mutation
requirements. The controls do not prove that every expected value is independent of the code
being tested. Likewise, unknown dependency resolution expands scope, while arbitrary filesystem
reads remain outside the static import graph; recognized fixture and data changes use the full
scope fallback. These are limits of the evidence, not claims of complete test-oracle analysis.

A standalone superficial test addition can pass when application behavior and original tests are
unchanged. It is not a certificate that the new test is useful. A later production change must
pass the production coverage and mutation gates using actual evidence. Existing-test weakening
does not receive this additive treatment. Missing legacy mutation evidence is never represented
as a cached passing result, and no threshold is lowered to make the rollout pass.

## Install and verify repository protection

The workflow must first be installed on `main`: a new `pull_request_target` workflow cannot
protect the pull request that introduces it. After the initial reviewed implementation lands,
an administrator with repository-administration API permission runs:

```sh
node scripts/quality/protection.mjs --apply
node scripts/quality/protection.mjs --check
```

When `CUBEPALS_ADMIN_GITHUB_TOKEN` is available in the environment, the installer passes it to
its GitHub CLI child process as `GH_TOKEN`. The secret does not need to be renamed or pasted
into commands or chat.

This preserves existing required checks, review rules, and push restrictions. It adds the
`Quality policy` status beside `check`, requires an up-to-date branch, and enables enforcement
for administrators. It also enables GitHub's **Require signed commits** protection for `main`
through the dedicated `required_signatures` endpoint, then independently reads that setting back.
`--check` fails unless verified signatures are required; a missing permission, missing setting,
or unsuccessful verification fails closed. Rollout commits must also be signed and verified;
disabling signing or using unsigned commits is not a bootstrap fallback.

Then open an ordinary PR and a deliberately failing policy PR. Confirm the expected status is
attached to each current head and that GitHub refuses to merge the latter. The local adversarial
suite tests the actual controller on temporary Git repositories:

```sh
node --test scripts/quality/policy.test.mjs
node --test scripts/quality/protection.test.mjs
```

The protection tests replace `gh` with a local fixture. They prove that unsigned-commit
protection cannot be reported as enabled when it is absent, disabled, unreadable, or unchanged
after an enable request, and that existing checks, reviews, and push restrictions are preserved.
They make no live repository changes.

At implementation time, both available GitHub credentials returned HTTP 403 for protection
administration. The readable branch summary showed `check`, title and label checks required,
with enforcement only for non-administrators. Repository-side activation and real GitHub merge
rejection, including required verified commit signatures, therefore remain unverified until
the installation steps succeed.

## Stronger isolation and policy updates

A required check associated with the GitHub Actions app identifies the app, not a particular
workflow. For resistance to deliberately malicious workflow/status spoofing, require this
workflow through a separately administered organization ruleset, or publish the required status
through a dedicated GitHub App whose credentials are unavailable to proposed code. Classic
branch protection alone does not establish that stronger boundary. Repository administrators
can always change controls they administer.

Ordinary PRs cannot modify protected files, even to raise a threshold. There is deliberately no
PR label, input, environment variable, or file that authorizes an exception. An administrator
must install a reviewed policy update through the independently administered protection
mechanism, restore/verify the required controls, and run the adversarial checks again. Keep
policy updates separate from feature changes so the exact trust-root change can be reviewed.
