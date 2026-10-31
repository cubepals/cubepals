<!-- SPDX-FileCopyrightText: 2026 The Cubepals Authors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Test quality rollout evidence

[PR 325](https://github.com/cubepals/cubepals/pull/325) introduced the gates and their executable
proofs. [Gate criteria](testing-quality.md#required-evidence) describe the per-file coverage and
mutation requirements; [the trust boundary](../scripts/quality/README.md) describes their limits
and the administration needed to make them mandatory on GitHub. The rollout remains incomplete:
the first main run failed, the standalone weak-test canary did not isolate its intended failure,
and server protection could not be activated or verified.

## Passing PR evidence

[CI run 41168591763](https://github.com/cubepals/cubepals/actions/runs/41168591763) passed on signed
PR head `1769227ed249fae4c125587ad616321a9763b6f0`. Its measured comparison was base
`639ba2a04b9103a9072b2399dc18addc7cddd848` against merge commit
`9ad4e49869300a8079a769129dfaa1df5f05b3b7`. All seven service artifacts agreed on that comparison;
their hashes, manifests, source inventory, and JUnit file identities were checked.

| Evidence | Observed result |
| --- | --- |
| [Complete CI](https://github.com/cubepals/cubepals/actions/runs/41168591763) | 4,018 executed application cases across 583 test files, with no failures or errors. The baseline executed 3,929 cases across 565 files. |
| [Per-file coverage](https://github.com/cubepals/cubepals/actions/runs/41168591763/artifacts/13030602722) | All 1,182 executable JavaScript/TypeScript files measured; no coverage regressions. Changed/new files met the applicable floors. |
| [Live Fleet reports](https://github.com/cubepals/cubepals/actions/runs/41168591763/artifacts/13030081809) | 15 one-node and 10 two-node cases passed, with 114 assertions and no failures, errors, or skips. |
| [Mutation reports](https://github.com/cubepals/cubepals/actions/runs/41168591763/artifacts/13030891188) | Access killed 8/8 mutants; reconciliation killed 357/401 (89.03%), with 44 survivors and no inconclusive results. Both selected files passed the 80% floor. |
| [Portable defect and weak-test proofs](https://github.com/cubepals/cubepals/actions/runs/41168591763/artifacts/13029953195) | All 16 clean cases passed. Four seeded defects failed their intended assertions. Superficial assertions killed only 4/11 mutants (36.36%) and were rejected; strong assertions killed 11/11. |
| [Java reporter evidence](https://github.com/cubepals/cubepals/actions/runs/41168591763/artifacts/13030472065) | PIT killed 76/78 mutants. Events killed 36/36, Queue 26/28, and Removals 14/14. Seeded HTTP-boundary defects, uncovered code, assertionless tests, and disabled tests were rejected. |

The ordinary shards recorded 31 allowed live-Fleet skipped entries: 25 named cases and six
unnamed hooks. The 25 named cases matched the separately executed live reports exactly. The
31 entries are not 31 executed tests. The
[service proof](https://github.com/cubepals/cubepals/actions/runs/41168591763/artifacts/13030139640)
also passed its clean concurrent-wake
control and rejected reusing a stranger's denial for a known player, with source hashes unchanged.
Timeouts and tool failures were not counted as killed mutants.

The coverage artifact retains **1,670 below-floor metrics across 712 legacy files**. Those files
passed only the applicable non-regression ratchet; they do not all satisfy the new-source floors.
For example, `app/backups/downloads.ts` measured 52/74 branches, 9/12 functions, and 100/114 lines;
`app/backups/download-records.ts` measured 8/11, 7/8, and 12/14 respectively. Java's unmodified
`Reporter.java` remained entirely uncovered in its separate report. These are test-evidence
deficits, not established production defects or a full-repository passing mutation scan.

## Hosted tamper canary

[PR 335](https://github.com/cubepals/cubepals/pull/335) used two GitHub-verified signed commits.
Its documentation-only control passed
[the trusted policy run](https://github.com/cubepals/cubepals/actions/runs/41170465458).
The next commit changed the protected branch floor from 80 to 79. The
[trusted controller rejected it](https://github.com/cubepals/cubepals/actions/runs/41170603793/job/124448064504),
and the publisher reported failure on exact head `d6473146a7045004fcebeac982c0c6cf65612611`.
Both subjects included `[skip ci]`; that did not suppress the trusted policy workflow.

PR 335 was closed without merging, and no merge attempt was made. This proves hosted tamper
detection and publication on the proposed commit. It does not prove that GitHub would refuse
a merge or prevent an administrator from bypassing checks.

## Failed and incomplete evidence

PR 325 landed as signed commit
[`0f61f6c21ff3e09fb4d7a3b4c1e6f6947fe0ceac`](https://github.com/cubepals/cubepals/commit/0f61f6c21ff3e09fb4d7a3b4c1e6f6947fe0ceac).
Its [main CI run](https://github.com/cubepals/cubepals/actions/runs/41170238093) failed in
[the access shard's baseline measurement](https://github.com/cubepals/cubepals/actions/runs/41170238093/job/124446448278).
The existing `app/edge/kept-address.test.ts` asserted an exact response before background wake
completion; the response still carried `wakeOperationId`. That was the only failed application
test job. The aggregate failed and per-file aggregation did not run, so the passing PR cannot
be reported as a passing main run. A deterministic local barrier reproduced the old test's
failure and passed the proposed synchronization repair. Its real Git-bound mutation scope still
contains **458 dependent production subjects**; that scope has not passed mutation validation.

[PR 337](https://github.com/cubepals/cubepals/pull/337) adds source with full local coverage and
superficial assertions. Its [first hosted run](https://github.com/cubepals/cubepals/actions/runs/41170512406)
expanded to 1,183 mutation subjects because of unresolved dynamic test imports. It failed on an
unrelated legacy edge module with a 0% mutation score; the remaining run was cancelled. This is
not a successful focused hosted proof that the canary's weak tests were rejected.

Base snapshots also omitted committed non-code imports, creating false unresolved dependencies.
Preserving regular JSON, CSS, and other asset identities repairs that comparison error. Genuine
unresolved imports still require the conservative full-inventory fallback when source changes;
the new-source canary's broader scope remains unresolved. The proposed synchronization repair's
458 subjects are its known dependency scope after correcting snapshot parity, not an exemption.
The hosted weak-test proof and the main-run repair require further evidence.

## Server activation is unverified

Both `protection.mjs --apply` and `--check` returned HTTP 403, "Resource not accessible by
integration", in the rollout environment. `CUBEPALS_ADMIN_GITHUB_TOKEN` was not present in that
running environment, despite being saved in its cloud configuration. The readable branch
summary required the older check, title, and label statuses only for non-administrators.

Follow [the activation procedure](../scripts/quality/README.md#install-and-verify-repository-protection)
from an independent administration context, then require successful readback. Until that succeeds,
the organization-owned required workflows, administrator bypass prevention, and mandatory signed
commit enforcement are not verified. Repository configuration and the failing canary status do
not establish those server guarantees. Actions artifacts have finite retention; the run and PR
links identify the original evidence when downloadable reports expire.
