# Blockly

The guide for anyone changing this repository, agent or human. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and tests; the rules below apply to every change.

## The core rule of Blockly's development

Blockly absorbs complexity so the player doesn’t have to.

Every new capability should first be designed as something Blockly can infer, automate, default, or hide. Expose a new control only when the user genuinely needs to make that decision.

### Guardrails

- **Automation is visible and can be undone.** When Blockly infers or fixes something, it says what it did and leaves a way back.
- **"Genuinely needs to decide" has a clear line.** It covers what only the player knows (the name, what to play, who plays), anything destructive or one-way (deleting a server, moving a world to a newer Minecraft), money (spending past the included hours), and who can reach their server (public or private, the whitelist). Everything else, Blockly decides.
- **Advanced stays out of the way.** Very technical users can be given options, but out of regular players' way; Blockly isn't built around them. Whether someone is building the next Hypixel or a server for their friends, they can do whatever they want through the simplest UI and UX possible.

## The name

Players know this product as **Cubepals**, at `cubepals.com`. **Blockly** is its codename.

- **What a person can see says Cubepals.** That covers page copy, titles, emails, error messages, in-game text such as the MOTD, the brand files, the films and the ads. Write "Cubepals" in sentences and **cubepals**, lowercase, in the wordmark. The possessive takes an apostrophe only: "Cubepals’ own machines".
- **The domain is `cubepals.com`, and nothing else.** The site is `cubepals.com`, realtime is `rt.cubepals.com`, and players join `<slug>.play.cubepals.com` (`PLAY_DOMAIN=play.cubepals.com`). Staging is `staging.cubepals.com`, with `rt.` and `play.` under it.
- **The repository is `cubepals/cubepals`.** Links to it, and anything that names it (Terraform's `repository`, CI), use that. blocklyd, the node daemon, is `cubepals/blocklyd`, under FSL-1.1-ALv2; this repository pins one of its releases (`bun scripts/blocklyd.ts`) and never copies its code.
- **Everything else stays Blockly.** That covers packages and workspaces (`@blockly/*`), `blocklyd` and other binaries, directories, env var names, database objects, Fly apps and orgs, Terraform resources, internal identifiers, code comments, docs under `docs/` and test names. Don't rename them to match the public name.
- **When it isn't clear whether a string is seen,** ask a maintainer rather than guess.

## Structure

A source file past about 800 lines, or one `impl` block, class or function past about 600, is split by concern before more is added to it. Splitting is its own change, titled `Move: …`, in which code moves and nothing else does. `bun run check:move-only` proves it.

`bun run check:structure` holds the tree to what a machine can judge:

- **Size:** a file at most 800 lines; an `impl` block, class, function or method at most 600.
- **Complexity:** Biome's cognitive complexity and lines per function. blocklyd's repository runs the same script with `--rust`, for clippy's `too_many_lines`, `cognitive_complexity` and `too_many_arguments`.
- **Names:** no file or directory called `utils`, `helpers`, `misc`, `common` or `shared`.
- **Headers:** a file over 50 lines opens with a doc comment.
- **Indexes:** the file named after a split's directory lists every file in it under ``Parts (`dir/`):``, each with what it is for.
- **Cycles:** no import cycle between TypeScript modules, or between the Rust crate's modules.
- **Unused:** no file, export or dependency that nothing uses, as knip finds them from the entry points in `knip.jsonc`.
- **Duplicates:** no TypeScript block of 12 lines and 80 tokens or more written twice, tests aside (jscpd).

It is a ratchet. What broke a rule before the rule existed is in `scripts/structure-baseline.json`, with its number and why. A check fails when anything gets worse, and when an entry is out of date. The baseline only shrinks: `--update` lowers its numbers and never adds one. Nobody fixes old code to get a change through, and nobody adds a baseline entry without saying why in it.

The checks stop things getting worse. They can't tell whether a seam is in the right place. That is on whoever makes the change, human or agent, with nobody reviewing behind them.

**The care.** A person who has never seen Blockly should be able to find where a thing lives, trust that the file holds one job, and change it without reading ten other files or breaking a neighbor. Split by what changes together, not by what is easy to cut. One job per file, nameable without "and", and named for the job, not a category. Don't split too far: ten tiny files that must all be opened to follow one flow are worse than one honest file. Dependencies point one way. The surface stays narrow and the same: what was private stays private, and what outsiders import keeps its old path. The header and the directory index say what each file is for and what it is deliberately not for, short and true, for someone who hasn't read the rest. Discipline over cleverness: if you are unsure where something belongs, leave it where it was and report it.

## Staging

Staging runs on Fly in the `blockly-staging` org, and it stays. When nobody is testing, its machines are stopped, not destroyed.

- **Start it before testing:** `bun scripts/staging.ts start`. **Stop it after:** `bun scripts/staging.ts stop`, and check that it reports every machine as stopped. `status` shows what exists and where to reach it.
- **Deploy a branch to it:** `bun scripts/staging.ts up`. It makes only what is missing and deploys this checkout. **Check it end to end:** `bun scripts/staging-check.ts`.
- **Never run `bun scripts/staging.ts down`** unless a maintainer asks for exactly that. It destroys staging, its database and worlds included.
- **In a cloud environment,** its variables stand in for a maintainer's machine:
  - `FLY_API_TOKEN` is an org token for `blockly-staging` only.
  - `POLAR_*` is Polar's sandbox.
  - `STAGING_STATE` replaces `local/staging/state.json`.

  Never print these values, and never put them in a commit, a PR or a message. If `fly` or `bun` is missing or not 1.3.11, the environment's setup script didn't run. Say so rather than working around it.
