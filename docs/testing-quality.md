# Test quality gates

The existing Bun runner, service-backed CI shards, Gradle/JUnit reporter tests, and runtime
fakes remain the test infrastructure. The Bun suite now uses seven groups: lifecycle, providers,
worlds, mods, web, access, and rest. The access group separates access, connections, and platform
tests from the largest remaining control-plane group. Istanbul adds real JavaScript/TypeScript
branch counters; Stryker runs the existing Bun tests against mutated source. JaCoCo and PIT supply the equivalent
evidence for the Java reporter. Fast-check exercises useful input spaces without replacing the
existing example and integration tests.

## What the audit found

Before these changes there were 545 TypeScript test files and four reporter test classes. CI
already exercised real Postgres, pg-boss, NATS, S3, ACME, Docker, and mc-router, with separate live
fleet runs, Worker/image smoke checks, and nightly staging checks. Runtime fakes already exposed
boot, stop, snapshot, restoration, release, export, and destruction failures. There were no
coverage thresholds, mutation checks, or property-testing dependencies.

Bun's native coverage did not supply an enforceable branch metric. The required CI aggregate
accepted every skipped dependency. Service-dependent tests deliberately skipped without their
environment variables; that was convenient locally but could conceal missing CI setup.
The separate Fleet workflow was not a required dependency and ran only the one-node suite;
the two-node suite had no repository workflow invocation. Both live suites now feed the required
CI result for applicable changes.

The first independent reporter measurement demonstrated why a universal retroactive threshold
would hide rather than resolve the rollout problem:

| Source | Branches | Methods | Lines |
| --- | ---: | ---: | ---: |
| Events.java | 93.75% | 100% | 100% |
| Queue.java | 61.11% | 77.78% | 66.67% |
| Removals.java | 80% | 80% | 90% |
| Listeners.java | 50% | 46.15% | 50.98% |
| Reporter.java | 0% | 0% | 0% |

These are observations, not committed exceptions. Every CI run measures the exact comparison
commit independently. Coverage findings list existing deficits by file instead of assigning them
an invented passing score. Live branch-protection findings and the remaining activation step are
documented in [the policy trust boundary](../scripts/quality/README.md).

The first complete JavaScript/TypeScript measurement, using the earlier six-shard layout,
covered 1,163 source files. It recorded 1,675 below-floor metrics across 715 files and rejected
11 coverage regressions across six
unchanged files. Deterministic tests address the missed failure paths. These findings and the
seeded-defect proofs demonstrate gaps in test evidence; they did not establish a production bug.

## Required evidence

Changed and new executable production files must reach **80% branches, 90% functions/methods, and 90% lines**.
Production and existing-test edits require every existing file to preserve its measured base
percentages and number of uncovered elements. The absolute-count check prevents padding a file with covered code to
conceal new uncovered behavior. A fully covered file therefore keeps its stronger existing bar.
With a Git-verified dependency-only update, the baseline comparison covers the affected oracle
closures. Verified test additions and quality-only inputs preserve earlier isolated test inputs;
sampling differences in unchanged code do not imply a regression. These narrower comparisons
require a fresh authoritative Git comparison and matching base inventory. Every source file is
still measured, every legacy deficit is reported, and changed-source floors always apply.
These floors leave a limited allowance for hard-to-exercise adapter details while requiring most
decision outcomes and almost every callable entry to be tested. Existing gaps remain visible and
must be resolved when their source changes.

The inventory comes from Git and syntax, independently of test imports. Unimported executable
files receive zero counters. Type declarations are distinguished structurally; generated and
test-support directories receive no general exemption. Production code cannot import a file
classified as a test or protected quality infrastructure. Quality infrastructure has its own
required controller tests and executable defect proofs. Missing, stale, malformed, or duplicate
shard evidence fails. The checker compares source hashes with the proposed checkout.

Each test shard measures both the comparison commit and the proposed source. For a PR, the
comparison is the checked-out merge's validated first parent, so another merged PR does not
become part of this PR's quality obligations. The baseline run writes a manifest of test paths
and hashes. On the proposed source, identical tests run first, then added or modified tests.
Every test file runs sequentially in a fresh Bun process. Instrumentation runs once per baseline
or proposed-source shard in a separate Node process; the test processes reuse a hashed compiled
module cache. This isolates native module state as well as JavaScript globals between test files.
After each file, the parent validates its JUnit result and exact coverage fragment, retains the
counters in memory, and removes the fragment before starting the next process. Tracked source,
tests, fixtures, and configuration must match their input snapshot after every file; the runtime
manifest must retain its hash. There is no fallback to shared Bun module realms.

The checker merges all seven shard reports before comparing per-file metrics. This preserves
coverage provided by integration tests in another shard. CI requires service variables, a
nonempty test run, every selected test file in JUnit, and no unexpected skipped cases. Only the
two existing live blocklyd test files may skip in these ordinary coverage shards. CI separately
calls the reusable Fleet workflow for both the one-node and two-node suites, with the pinned
daemon binaries, Docker, Postgres, and S3 they need. Live Fleet evidence must contain both exact
test files with executed cases and no failures, errors, or skips. Missing or malformed evidence
fails, as does a failed, cancelled, missing, or unexpectedly skipped Fleet job.

All control-plane, shared-package, script, and tool changes require Fleet. Package manifests,
lockfiles, Bun/TypeScript configuration, root runtime configuration, and the CI/Fleet workflows
also require it. Unrelated web, edge, or reporter source changes can skip that job; the required
aggregate verifies the explicit classification. Merge-queue, scheduled, and manual CI runs
always execute Fleet. The standalone Fleet workflow retains weekly and manual runs, while PR
and main-push execution comes through CI to avoid duplicate runs.

Mutation testing requires **80% killed mutants per selected file’s changed code**, rather than a project average.
Timeouts, compilation errors, missing reports, skipped-away tests, and runner failures cannot count
as detected defects. A clean test baseline must pass first. Stryker uses its maintained mutators
and built-in command runner, including condition boundaries, removed blocks, changed operators,
and altered return values. Disposable copies repair workspace package links so a mutated package
import cannot accidentally resolve to the original unmutated checkout.
Files with no independently generated mutation candidates report that condition explicitly;
they still require a clean baseline and their applicable coverage metrics.

PR mutation scope includes the added/replaced lines of changed executable production files,
held to the 80% mutation floor independently for each file. New and renamed files retain their
whole-file census. A deletion-only hunk conservatively retains the full affected file. A changed integration test, test deletion, fixture, dependency or runtime
configuration does not impose that floor on unchanged legacy files. Changed executable helpers
remain subjects when the inventory classifies them as source. All dependent tests remain
available for each selected subject, including ambiguous possible dependents.

`mutation-release-scope.mjs` verifies the complete Git comparison through the existing test-impact
verifier, then selects changed production paths. `mutation-lines.mjs` derives native Stryker ranges
from zero-context Git hunks and verifies each source against the committed blob. Independent
enumeration records both the whole-file and selected candidate counts, source hash and every
selected candidate identity. The actual report must match that exact selected census. Import, type
or comment changes with no mutable expressions say so explicitly, rather than claiming a full-file pass.
Missing tests for changed source still fail;
callers cannot omit a source edit from the supplied diff. Comparison metadata remains bound to
the authoritative base and head SHAs from the protected workflow.

Coverage has its own unchanged conservative impact analysis and baseline ratchet. Functional
suites, coverage floors, test-policy checks, builds and live Fleet E2E remain release gates.
Legacy mutation debt is checked in the separate **Mutation audit** workflow: scheduled runs use
seven daily partitions covering the whole inventory each week; manual full audits remain available.
These audits report real failures independently of ordinary release CI.

### Test files that only gained cases

An existing test file whose cases are all unchanged, and which only gained new ones, is judged as
an addition, like a new test file (`test-appends.mjs`). This holds only when:

- every base case is in the head with the same source, and the new statements are plain
  `test(...)` or `it(...)` calls placed after every existing case, so they run after them, holding
  only a literal name, an inline function and an optional numeric timeout, since their arguments
  run while the file is collected;
- removing them leaves the base file's tokens and comments, apart from names added to an import
  the base already had, which no existing code uses;
- the base has no concurrent cases, no after-hook that asserts, and no `afterAll` hook that calls
  anything but cleanup methods such as `close` or `stop`, since it runs after the new cases.

Any other edit, such as a changed or removed case, a weakened helper, a new hook, a new skip or a new
import, leaves the file an edited test for conservative coverage-impact analysis. Mutation
subjects still come from changed production paths.

### Database skips in new test files

A new test file in the control plane may carry exactly `describe.skipIf(!hasDatabase)`, once, when
it imports `hasDatabase` and `startHarness` from `apps/control/src/testing/harness.ts` under their
own names and calls `startHarness`. Every other new skip is still refused. CI always provides
Postgres, and its JUnit evidence refuses any skipped case except the live Fleet suites, so this
skip can't run in CI.

### Dependency-only updates

A dependency update is judged by what it can break. `dependency-impact.mjs` accepts a change as
dependency-only when every changed file is `bun.lock`, a `package.json`, or the inert
`.github/dependabot.yml`; manifests differ only in the registry versions of packages they already
declare; lock settings, overrides, patches and workspaces are unchanged; each workspace entry in
the lock agrees with its manifest; and every changed lock record is a registry tarball with an
integrity hash. Anything else in the diff, or anything the module cannot prove, leaves the
conservative full coverage comparison in force.

Dependency-only releases run the complete functional suites, coverage comparisons and applicable
build/Fleet checks. Because application source is unchanged, they do not run paired base/head
mutation audits of unchanged code. Dependency-impact classification still determines conservative
coverage comparisons. If source changes accompany an update, every changed production file remains
a mutation subject at the normal 80% threshold. Protected policy checks still apply to dependency
and test configuration changes.

### Mutation time budget

Each subject has a budget scaled from 20 minutes by its mutant count, capped at 60 minutes.
A kill needs a real assertion failure; the runner stops after the failing file or clean-proven
case batch, allowing cleanup hooks to finish. A survivor runs every original selected case. A mutant that would start after the
subject's deadline is recorded as `budget-exhausted` instead of running. It gets no kill credit,
counts against the score, and is reported by number, so Stryker always finishes and writes its
report inside the budget rather than being stopped mid-run. The deadline leaves one test timeout
and a minute for Stryker to finish. A subject that runs out of time fails, with the count of
mutants left unevaluated in its message. An expansion to more dependent tests never starts past
the deadline; the last full census stands, and it fails with its own score.

Test-addition classification continues to protect baseline coverage evidence. No unmeasured legacy
mutation result is represented as passing. Java PIT follows the same release rule: changed production
classes are run in full by PIT, but release scores use their changed lines. The raw complete
PIT report and selected-line counts are retained. Full audits score all legacy classes and lines.

Mutation runs begin with small dependent test suites and expand to other proven dependents when
the complete selected per-file mutant census does not meet the threshold. Each attempt keeps the same census;
kills are not combined across different attempts. The full ordinary test suite still runs.
Scheduled JavaScript/TypeScript mutations rotate through seven stable source partitions, visiting
the complete executable inventory over a successful week; manual full runs cover every partition.
The smaller Java reporter inventory receives a full scheduled run. A cancelled or
timed-out partition is incomplete, never a passing full scan. A failing scheduled run is
actionable debt, not evidence that every legacy module already meets the new floor.

No test-name convention can prove that a boundary or failure contract is asserted. Coverage
requires executed alternatives, mutation requires observable sensitivity to defects, and semantic
properties supply independent expectations. The added properties cover same-origin redirects,
connection accounting, exact token boundaries, IPv6 grouping, and PROXY header fragmentation.
Injected transport, parse, and route-application failures verify recovery without acknowledging
work that did not succeed. Concurrent wake tests hold real eligibility reads and starts behind
explicit barriers, proving that a known player is reconsidered after another join is denied and
that eligible concurrent joins share one start. Seeds and bounded run counts make failures reproducible.

## Reproduce the enforcement proofs

```sh
bun run test:quality
bun run test:quality:proof
python3 scripts/quality/reporter-proof.py
```

The proofs execute the real gate entrypoints in disposable repositories or copies. They verify
clean controls pass, then reject removed negative-path tests, never-imported source, covered-code
padding, malformed/missing evidence, threshold/exclusion/workflow edits, strong tests replaced
by superficial assertions, and deliberate defects. They also prove that renamed weak tests
retain their coverage obligations and that forged comparison metadata fails. Production
source in the working checkout is not mutated. The policy proofs also reject install lifecycle
hooks that could rewrite the coverage controller, changes to Lefthook configuration and its
dependencies, trusted install dependency changes, and executable-name shadowing. All package
script entrypoints are protected, including pre/post hooks around ordinary CI commands.
Behavioral, Stryker, and reporter proof reports and logs are written under `coverage/`.
The access shard also runs a service-backed behavioral proof: its clean concurrency tests pass,
then reusing a stranger's denial for a known player must fail the intended assertion. This makes
the ordering guarantee executable evidence rather than relying on a race happening to occur.
With the local test services configured, run it directly with:

```sh
node scripts/quality/behavior-proof.mjs "$PWD" "$PWD/coverage/service-proof" services
```

For a service-enabled CI shard, after its baseline measurement has produced the test manifest,
the workflow is the reference:

```sh
node scripts/quality/run-shard.mjs "$PWD" web "$PWD/coverage/quality/head" \
  "$PWD/coverage/quality/base/manifests/web.json"
node scripts/quality/coverage.mjs merge --expected-shards 7 --output coverage/head.json coverage/quality/head/*.json
node scripts/quality/coverage.mjs check --report coverage/head.json --base coverage/base.json \
  --changed coverage/changed.json --root . --output coverage/findings.json
```

The `check` status explicitly requires successful quality jobs whenever code changed. Policy
checks run separately from trusted base code and publish their result on the exact proposed
commit. Protecting that status on the server is necessary: repository files alone cannot prevent
an administrator or an unprotected workflow from bypassing checks. The installer preserves the
existing repository protections and requires an independently administered organization ruleset
for this repository's `main` branch. That rule requires the actual CI and quality-policy workflows
from protected `main`, signed commits, and pull requests, with no bypass actors. It does not add a
human-approval requirement. A matching check name from another workflow cannot satisfy the
required-workflow rule. Verification fails when either protection layer is missing or unreadable.
Repository and organization administration are separate permissions; routine agents must not
hold credentials that can administer the organization rule. Required workflow runs finish rather
than cancelling their evidence when another revision arrives. Rollout commits must be signed too,
with no unsigned bootstrap fallback.

Separate test processes, ordered phases, input snapshots, and lexical policy checks are complementary
controls. They are not a security sandbox for arbitrary JavaScript or a proof that expected
values are independent of application code. Processes still share the filesystem and test services;
process isolation does not prevent malicious filesystem writes. The trust-boundary document
states these limits and the external administration boundary required for server enforcement.
