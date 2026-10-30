# Test quality gates

The existing Bun runner, six service-backed CI shards, Gradle/JUnit reporter tests, and runtime
fakes remain the test infrastructure. Istanbul adds real JavaScript/TypeScript branch counters;
Stryker runs the existing Bun tests against mutated source. JaCoCo and PIT supply the equivalent
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

## Required evidence

Changed and new executable files must reach **80% branches, 90% functions/methods, and 90% lines**.
Every existing file must preserve its measured base percentages and may not increase its number
of uncovered elements. The absolute-count check prevents padding a file with covered code to
conceal new uncovered behavior. A fully covered file therefore keeps its stronger existing bar.
These floors leave a limited allowance for hard-to-exercise adapter details while requiring most
decision outcomes and almost every callable entry to be tested. Existing gaps remain visible and
must be resolved when their source changes.

The inventory comes from Git and syntax, independently of test imports. Unimported executable
files receive zero counters. Type declarations are distinguished structurally; generated and
test-support directories receive no general exemption. Production code cannot import a file
classified as a test or protected quality infrastructure. Quality infrastructure has its own
required controller tests and executable defect proofs. Missing, stale, malformed, or duplicate
shard evidence fails. The checker compares source hashes with the proposed checkout.

Each test shard runs once against the comparison commit and once against the proposed source.
The checker merges all six reports before comparing per-file metrics. This preserves coverage
provided by integration tests in another shard. CI requires service variables, a nonempty test
run, every selected test file in JUnit, and no unexpected skipped cases. Only the two existing
live blocklyd test files may skip here; the separate fleet workflow supplies their live nodes.

Mutation testing requires **80% killed mutants per selected file**, rather than a project average.
Timeouts, compilation errors, missing reports, skipped-away tests, and runner failures cannot count
as detected defects. A clean test baseline must pass first. Stryker uses its maintained mutators
and built-in command runner, including condition boundaries, removed blocks, changed operators,
and altered return values. Disposable copies repair workspace package links so a mutated package
import cannot accidentally resolve to the original unmutated checkout.

PR mutation scope includes changed production files and the source dependencies of changed tests.
It includes test-only changes; uncertain dependency mapping expands the scope. Focused dependent
tests keep this affordable, while the full existing suite still runs. Scheduled runs rotate through seven stable source partitions, visiting the complete executable
inventory over a successful week; manual full runs cover every partition. A cancelled or timed-out
partition is incomplete, never a passing full scan. A failing scheduled run is
actionable debt, not evidence that every legacy module already meets the new floor.

No test-name convention can prove that a boundary or failure contract is asserted. Coverage
requires executed alternatives, mutation requires observable sensitivity to defects, and semantic
properties supply independent expectations. The added properties cover same-origin redirects,
connection accounting, exact token boundaries, IPv6 grouping, and PROXY header fragmentation.
Injected transport, parse, and route-application failures verify recovery without acknowledging
work that did not succeed. Seeds and bounded run counts make failures reproducible.

## Reproduce the enforcement proofs

```sh
bun run test:quality
bun run test:quality:proof
python3 scripts/quality/reporter-proof.py
```

The proofs execute the real gate entrypoints in disposable repositories or copies. They verify
clean controls pass, then reject removed negative-path tests, never-imported source, covered-code
padding, malformed/missing evidence, threshold/exclusion/workflow edits, superficial assertions,
and deliberate defects. Production source in the working checkout is not mutated. Behavioral,
Stryker, and reporter proof reports and logs are written under `coverage/`.

For a service-enabled CI shard, the workflow is the reference:

```sh
node scripts/quality/run-shard.mjs "$PWD" web "$PWD/coverage/quality/head"
node scripts/quality/coverage.mjs merge --expected-shards 6 --output coverage/head.json coverage/quality/head/*.json
node scripts/quality/coverage.mjs check --report coverage/head.json --base coverage/base.json \
  --changed coverage/changed.json --root . --output coverage/findings.json
```

The `check` status explicitly requires successful quality jobs whenever code changed. Policy
checks run separately from trusted base code and publish their result on the exact proposed
commit. Protecting that status on the server is necessary: repository files alone cannot prevent
an administrator or an unprotected workflow from bypassing checks. The installation instructions
include an administrator-enforcement check and describe the stronger independently administered
workflow/App boundary needed against deliberately malicious workflow spoofing.
