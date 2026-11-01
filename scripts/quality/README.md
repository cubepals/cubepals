<!-- SPDX-FileCopyrightText: 2026 The Cubepals Authors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Quality policy trust boundary

Incremental evidence distinguishes runtime inputs from structure metadata. A structure baseline
may avoid application-wide mutation only when its existing allowances are retained, tightened or
removed without other metadata changes. A literal JSON, CSS or HTML import is a data leaf: changes
retain the base and head importing code, its consumers and affected tests. Unmapped data or an
ambiguous loader still requires the full inventory.

Each isolated test's validated counters also produce a source- and test-hashed execution profile.
Mutation runs try tests that actually execute the subject before tests that merely import a shared
harness. Every static candidate remains available for expansion; subjects, mutants, score floors
and incomplete-evidence failures are unchanged. Dependency comparisons keep their identical oracle
sets and do not use this reordering.

An executing module-owned suite precedes incidental consumers, so router and service tests run
before integration suites that happen to construct them. Slow suites may run in case batches,
ordered by measured duration. Every batch must first pass on clean source and together cover the
complete original case inventory; otherwise the original invocation remains in use. A surviving
mutant must execute every original case. Early termination needs an actual assertion failure;
missing cases, unexpected skips, runner errors and timeouts remain inconclusive. Raw batch reports
are retained, and dependency-only comparisons disable case batching on both sides.

Six old billing cases already skip in the first three to twelve hours of a month.
Each existing condition is recognised only for its pinned complete source hash, exact test name,
and the trusted parent's actual calendar window. Skips remain visible in JUnit; an edited
fixture or any other skip still fails. The corrected fixture uses a complete future-month window
and executes every case. Test clocks and source files are never rewritten for this compatibility.

Coverage's aggregate independently reconstructs its comparison from Git after downloading test
artifacts. Existing-test and production edits retain the complete baseline ratchet. Verified test
additions and quality-only inputs preserve the old isolated test inputs, so timing differences in
unchanged code do not constitute a regression. Dependency-only updates compare the affected oracle
closures. Every module remains measured, legacy deficits remain visible, and changed-source floors
always apply. Missing Git identity or mismatched base coverage cannot establish a narrower scope.

`quality-policy.yml` reads the controller from the pull request's base commit and reads proposed
files as Git objects. It does not install packages, import modules, follow proposed symlinks, or
run scripts from the proposed tree. A separate job publishes `Quality policy` on the exact head
commit. Failure, cancellation, and an unexpectedly skipped controller publish failure.
PR edits rerun the policy check, including changes to the target branch.

`policy.mjs` protects the quality controller, workflows, ownership file, test configuration,
reporter Gradle configuration and wrapper, and every package script entrypoint. This includes
the dependency-free `packages/contracts/src/durations.ts` leaf: controllers import its canonical
units before their input snapshots. Direct relative imports avoid workspace export redirection,
and the policy rejects changes to that executable dependency through ordinary PRs. Existing
execution budgets are unchanged.
The protected entrypoints also include
install lifecycle scripts and the pre/post hooks Bun runs around ordinary CI commands. Lefthook
configuration variants, rc files, hook directories, and the current hook's two repository scripts
are protected, as are package-manager rc files and package binary declarations. The existing
`prepare` command invokes only Lefthook; changing that command requires a reviewed policy update.
Quality tools, Lefthook, and explicitly trusted install dependencies retain their versions,
resolution records, integrity hashes, and complete transitive lock graphs. New or changed package
binaries cannot shadow those tools or the node, Bun, Git, and shell executables they invoke.
Unrelated dependency updates may change `bun.lock`; changes to a dependency shared with a protected
tool require a policy update. New skip/focus modifiers and coverage/mutation suppression comments
are refused. Existing direct conditional-member skips are frozen by expression and occurrence count.
Reporter test annotations that disable or conditionally enable a case, and JUnit assumptions,
cannot be introduced through an ordinary PR.
New direct references to coverage counters, active mutant identifiers, and quality evidence
locations are also refused outside protected infrastructure, including quoted property names.

The local gate runs the controller suite with Node. Bun's exact `scripts/quality/*.test.mjs`
discovery exclusion prevents running those same controller tests again under the wrong runtime;
application tests remain included. The configuration-impact check accepts only that exact routing
addition while the Node suite remains mandatory. Broader Bun configuration changes retain the
normal configuration-change obligations.

The lexical scan catches ordinary exclusion, test-disabling, and evidence-aware changes. It is not a JavaScript
security sandbox or proof that an arbitrary program is honest. Executable tests can inspect or
forge their own process state. Coverage, mutation, invariant tests, strict evidence validation,
and the policy guard provide complementary evidence, not a proof of all possible behavior.
The modifier scan reserves `only`, `skip`, `todo`, `if`, `skipIf`, `runIf`, `todoIf`, `failing`, and
`failingIf` as member and binding keys in test files, so ordinary APIs and object properties using
those names can also be rejected. The disabled Bun exports `xit`, `xtest`, and `xdescribe` are
reserved identifiers too, including named-import aliases and quoted import or property keys.
Conditional member expressions are frozen too. This conservative scan catches aliased runners,
literal computed properties, and extracted references such as `const disabled = test.skip` and
`const { 'skip': disabled } = test` without executing proposed code. Restricting it to familiar
receiver names would let runner aliases bypass the check; ordinary-API false positives remain a
limit. A regression test inventories the pinned Bun runner exports, method declarations, and test
options so a runtime upgrade requires repeating the audit. Scheduling methods (`concurrent`,
`serial`, and their conditionals) and data-driven `each` remain available; arbitrary conditional
registration or empty test data still requires behavioral evidence, not lexical certification.
The scan does not resolve names assembled through variables or follow later calls through a
preexisting extracted alias.
The install protections cover the repository's current entrypoints and declared trusted dependency
graph. They are not a general shell interpreter, a registry audit, or a sandbox for executable
application code. A policy update that introduces another lifecycle helper or Lefthook include
must protect its new repository-controlled inputs too.

## Incremental test obligations and legacy code

New and changed executable production files must meet 80% branch, 90% function/method, and 90%
line coverage, plus the 80% mutation floor. Modifying deficient source requires closing its test
evidence gap; one-line edits and moves do not waive those floors. Unchanged legacy files retain
measured coverage through a non-regression ratchet. The initial complete hosted measurement,
using the earlier six-shard layout, covered 1,163 source files:
715 had 1,675 legacy metric deficits (605 branch, 566 function, and 504 line deficits).
Those deficits are visible debt, not evidence
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
Each test file runs sequentially in a fresh Bun process; added or modified files start only after
the original files finish. Instrumentation runs once per baseline or proposed-source shard in a
separate Node process, and each test process reuses the hashed compiled module cache. After each
file, the parent verifies its JUnit and exact coverage fragment, retains the evidence in memory,
and removes the fragment before the next process starts. Tracked source, tests, fixtures, and
configuration must match their input snapshot after every file, and the runtime manifest hash
must remain unchanged. This preserves original-test evidence across later test executions and
avoids shared native module state. There is no fallback to shared Bun module realms.
The seven coverage groups are lifecycle, providers, worlds, mods, web, access, and rest; the
aggregate requires all seven reports. Fresh processes still share files and external services:
process isolation is not a security sandbox and does not prevent malicious filesystem writes.
The Java reporter continues to use class-based PIT selection for its test changes.

The two live Fleet files may skip only in ordinary coverage and mutation runs that lack the
real daemon. Applicable CI runs call the reusable Fleet workflow and require both one-node and
two-node evidence with zero skipped cases. The required aggregate rejects a failed, cancelled,
missing, or unexpectedly skipped Fleet job. The protected path classifier selects all control-plane,
shared-package, script, and tool changes, all package manifests and lockfiles, Bun/TypeScript and
root runtime configuration, and the CI/Fleet workflows. Unrelated web, edge, or reporter source
can skip Fleet; merge-queue, scheduled, and manual CI runs always execute it. This dependency
places live Fleet failures inside the existing required `check` and trusted CI workflow rather
than depending on an optional external check name.

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
of trusting an unproved mapping. Adding or changing production source retains full scope when
any test dependency remains unresolved: new modules can change dynamic-loader fallback behavior,
and even modules with production importers and direct tests can also be test oracles.
The base view also holds the committed JSON, CSS and HTML files under `apps`, `packages`, `scripts`
and `tools`, read from Git and never executed, so static data imports resolve in both revisions
without relaxing the fallback for genuinely unknown imports. No directory name exempts executable test
helpers from coverage or mutation. Scheduled runs audit the complete source inventory in stable partitions.

An existing test file that only gained plain cases after every existing one (`test-appends.mjs`),
with everything else byte-for-byte as before except names added to an existing import, counts as an
addition. Any other edit keeps the edited-test rule. The policy lets a new control-plane test file
carry exactly `describe.skipIf(!hasDatabase)` when it starts the database harness. Every other new
skip is refused, and CI's JUnit evidence still refuses a skipped case.

A dependency-only update (`dependency-impact.mjs`: only `bun.lock`, manifests whose registry
versions moved, and `.github/dependabot.yml`) owes no new-code floor, because no source or test
byte changed. The whole suite and the coverage ratchet still run. Tests that load an updated
package themselves, or through a module only tests reach, are its possible weaker oracles: their
source closures are measured with those tests on the base worktree and must reach the same score on
the head. Any other changed file makes the update ineligible, so a weakened test in the same pull
request keeps the full-scope rule and its own subjects. Packages whose install holds only type
declarations and documents are inert. The reasoning and its limits are in
[docs/testing-quality.md](../../docs/testing-quality.md#dependency-only-updates).

A subject that reaches its time budget records the remaining mutants as `budget-exhausted`: no
kill credit, counted against the score, and named in the failure. Stryker always finishes and
reports instead of being stopped mid-run.

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
an administrator with both repository and organization administration API permissions runs:

```sh
node scripts/quality/protection.mjs --apply
node scripts/quality/protection.mjs --check
```

When `CUBEPALS_ADMIN_GITHUB_TOKEN` is available in the environment, the installer passes it to
its GitHub CLI child process as `GH_TOKEN`. The secret does not need to be renamed or pasted
into commands or chat.

The installer creates or maintains the organization-owned `Cubepals automated test quality`
ruleset. Its scope is exactly repository ID `1415897625` and `refs/heads/main`, with no bypass
actors. It requires `.github/workflows/ci.yml` and `.github/workflows/quality-policy.yml` from
this repository's trusted `refs/heads/main`, verified commit signatures, and pull requests.
The added pull-request rule requires zero human approvals; existing stricter review rules
remain in force. Other rulesets, unrelated rules, and additional required workflows are preserved.
An ambiguous name or different repository/ref scope stops the installer instead of repurposing
another rule. The installer verifies both trusted workflow files exist before making changes,
then reads the organization rule back independently. A conforming organization rule is not rewritten.

Classic protection alone cannot pass `--check`. The organization workflow rule requires
[organization Administration(write)](https://docs.github.com/en/rest/orgs/rules#create-an-organization-repository-ruleset),
distinct from the repository Administration(write) permission used for branch protection.
Organization owners or delegated organization ruleset managers must authorize that boundary.
Missing permission, an unsupported workflow-rule API, or a failed readback stops activation;
there is no fallback that reports classic protection as sufficient.

The installer also preserves existing required checks, review rules, and push restrictions. It adds the
`Quality policy` status beside `check`, requires an up-to-date branch, and enables enforcement
for administrators. It also enables GitHub's **Require signed commits** protection for `main`
through the dedicated `required_signatures` endpoint, then independently reads that setting back.
`--check` fails unless verified signatures are required; a missing permission, missing setting,
or unsuccessful verification fails closed. Rollout commits must also be signed and verified;
disabling signing or using unsigned commits is not a bootstrap fallback.

GitHub supports both check runs and commit statuses as required checks, including restriction to
an expected GitHub App. The REST `app_id` setting pins that source; `GITHUB_TOKEN` authenticates as
the Actions App's installation token. Posting `Quality policy` through the commit-status API is
therefore compatible with an App-pinned requirement. See [protected branch status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging),
[the protection API](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection),
and [the token's authentication model](https://docs.github.com/en/actions/concepts/security/github_token).
These API semantics do not establish that this repository's protection is activated; live
verification of the required status and blocked merges remains necessary.

Then open an ordinary PR and a deliberately failing policy PR. Confirm the expected status is
attached to each current head and that GitHub refuses to merge the latter. The local adversarial
suite tests the actual controller on temporary Git repositories:

```sh
node --test scripts/quality/policy.test.mjs
node --test scripts/quality/protection.test.mjs
```

The protection tests replace `gh` with a local fixture. They prove that missing or weakened
organization workflow rules, scope changes, bypass actors, unavailable administration, and
unapplied writes fail verification. They also verify idempotent creation and preservation of
unrelated rules. Signature protection cannot be reported as enabled when it is absent, disabled,
unreadable, or unchanged after an enable request; existing checks, reviews, and push restrictions remain.
They make no live repository changes.

At implementation time, both available GitHub credentials returned HTTP 403 for protection
administration. The readable branch summary showed `check`, title and label checks required,
with enforcement only for non-administrators. Repository-side activation and real GitHub merge
rejection, including organization workflow enforcement and verified commit signatures, remain unverified until
the installation steps succeed.

## Stronger isolation and policy updates

A required check associated with the GitHub Actions app identifies the app, not a particular
workflow. The required organization workflows supply that independent identity: posting another
successful status with the same name cannot substitute for either required workflow. Repository
administrators cannot weaken an organization-owned rule merely by changing repository protection.
Routine agents and proposed-code CI jobs must not receive organization-administration credentials;
an organization administrator can still edit the rules it administers. Provisioning credentials
belong only in the separate activation context, not in ordinary agent sessions.

GitHub supports `pull_request_target` and `merge_group` for required workflows. Ruleset runs ignore
event filters and use default activity types, so the repository workflow retains its separate
`edited` trigger for PR retargeting. An already open PR needs a new supported event after rule
installation. Required workflows must complete without `cancel-in-progress` cancellation.
See [ruleset workflow requirements](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules).

Ordinary PRs cannot modify protected files, even to raise a threshold. There is deliberately no
PR label, input, environment variable, or file that authorizes an exception. An administrator
must install a reviewed policy update through the independently administered protection
mechanism, restore/verify the required controls, and run the adversarial checks again. Keep
policy updates separate from feature changes so the exact trust-root change can be reviewed.
