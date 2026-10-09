# Contributing

Cubepals is developed under the codename Blockly, so the code, packages and binaries all say
Blockly. [CLAUDE.md](CLAUDE.md) holds the rules every change follows, for people and agents alike;
this page is how to work on it.

## The core rule

Blockly absorbs complexity so the player doesn't have to. A new capability is first designed as
something Blockly can infer, automate, default or hide; a new control appears only when the player
genuinely needs to make that decision. The guardrails, and where that line is, are in
[CLAUDE.md](CLAUDE.md#the-core-rule-of-blocklys-development).

## Setup

[docs/local-development.md](docs/local-development.md) runs the whole stack on one machine from a
fresh clone, with no outside account. In short, with Bun and Docker installed:

```sh
bun run dev            # dependencies, containers, migrations, then the control plane and the web app
bun run dev:accounts   # one signed-up account per plan, with `bun run dev` running
```

The design is in [docs/architecture.md](docs/architecture.md). Read it before changing a boundary.

## Tests

```sh
bun test path/to/file.test.ts   # one file
bun test                        # the TypeScript suite
bun run typecheck
bun run lint                    # Biome; `bun run format` writes its fixes
bun run gates                   # lint, typecheck, boundaries, structure, deprecations and tests
```

Some tests need real services and skip without their variables: `DATABASE_URL` for Postgres,
`S3_TEST_*` for an object store, `NATS_TEST_URL`, `PEBBLE_TEST_URL` and `CHALLTESTSRV_TEST_URL`.
`.github/workflows/ci.yml` starts each one and sets its variable, and is the reference.

blocklyd, the fleet node daemon, is Rust. From `apps/blocklyd`:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

## Structure

`bun run check:structure` holds the tree to what a machine can judge: file and function size,
complexity, banned names (`utils`, `helpers` and the like), file headers, directory indexes, import
cycles, unused code and duplicates. Add `--rust` for blocklyd. It is a ratchet: what broke a rule
before the rule existed is listed in `scripts/structure-baseline.json` with why, and that list only
shrinks. A change that makes anything worse fails. [CLAUDE.md](CLAUDE.md#structure) has the full
rules and the care the checks can't judge.

**Splits are their own change.** A source file past about 800 lines, or a function, class or
`impl` block past about 600, is split by concern before more is added to it. The split is a pull
request titled `Move: …` in which code moves and nothing else does; `bun run check:move-only`
proves it, and CI runs it on every `Move:` pull request.

## How changes land

`main` is the trunk, and it is always meant to work. There are no long-lived branches.

1. Branch from `main`, keep the change small, and open a pull request early.
2. CI's `check` must pass. Pull requests are squash-merged, so the title becomes the commit on
   `main`: write it as a plain sentence about what changes. The branch is deleted on merge.
3. Work that isn't finished can still merge if nobody can reach it yet; that beats a branch that
   drifts for weeks.

`main` takes no force pushes and keeps a linear history.

**Production** is the `production` branch, which only moves forward: a maintainer's
`bun scripts/production.ts apply` pushes the commit being deployed to it, and cubepals.com is built
from there.

## Staging

Changes that touch providers are checked on staging (`bun scripts/staging.ts`, rules in
[CLAUDE.md](CLAUDE.md#staging)). It needs a maintainer's access; ask in your pull request.

Every night, the Nightly workflow deploys main to staging, runs `scripts/staging-check.ts` and stops
staging again. A commit that passes is tagged `v<next>-nightly.<date>.<run>`. Production deploys only
such a commit, as the next `vX.Y.Z` (`scripts/versions.ts`).

## Conduct and security

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md). Security problems are reported
privately, as [SECURITY.md](SECURITY.md) says, never in an issue. Help with an account on
cubepals.com is in [SUPPORT.md](SUPPORT.md).

## Brand

The code is AGPL-3.0. The Cubepals name, the files in `brand/`, the landing page
(`apps/web/src/landing/`), the pictures in `apps/web/public/imagery/` and
`apps/web/public/guides/`, and the guides' words are not:
[brand/LICENSE.md](brand/LICENSE.md). A change to them is contributed under those terms.
