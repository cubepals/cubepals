<!-- SPDX-FileCopyrightText: 2026 The Cubepals Authors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Quality policy trust boundary

`quality-policy.yml` reads the controller from the pull request's base commit and reads proposed
files as Git objects. It does not install packages, import modules, follow proposed symlinks, or
run scripts from the proposed tree. A separate job publishes `Quality policy` on the exact head
commit. Failure, cancellation, and an unexpectedly skipped controller publish failure.

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

## Install and verify repository protection

The workflow must first be installed on `main`: a new `pull_request_target` workflow cannot
protect the pull request that introduces it. After the initial reviewed implementation lands,
an administrator with repository-administration API permission runs:

```sh
node scripts/quality/protection.mjs --apply
node scripts/quality/protection.mjs --check
```

This preserves existing required checks, review rules, and push restrictions. It adds the
`Quality policy` status beside `check`, requires an up-to-date branch, and enables enforcement
for administrators. A missing permission fails; it does not silently claim success.

Then open an ordinary PR and a deliberately failing policy PR. Confirm the expected status is
attached to each current head and that GitHub refuses to merge the latter. The local adversarial
suite tests the actual controller on temporary Git repositories:

```sh
node --test scripts/quality/policy.test.mjs
```

At implementation time, both available GitHub credentials returned HTTP 403 for protection
administration. The readable branch summary showed `check`, title and label checks required,
with enforcement only for non-administrators. Repository-side activation and real GitHub merge
rejection therefore remain unverified until the installation steps succeed.

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
