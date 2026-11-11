# Blockly

The guide for anyone changing this repository, agent or human. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and tests; the rules below apply to every change.

## The core rule of Blockly's development

Blockly absorbs complexity so the player doesn’t have to.

Every new capability should first be designed as something Blockly can infer, automate, default, or hide. Expose a new control only when the user genuinely needs to make that decision.

### Guardrails

- **Automation is visible and can be undone.** When Blockly infers or fixes something, it says what it did and leaves a way back.
- **"Genuinely needs to decide" has a clear line.** It covers what only the player knows (the name, what to play, who plays), anything destructive or one-way (deleting a server, moving a world to a newer Minecraft), money (spending past the included hours), and who can reach their server (public or private, the whitelist). Everything else, Blockly decides.
- **Advanced stays out of the way.** Very technical users can be given options, but out of regular players' way; Blockly isn't built around them. Whether someone is building the next Hypixel or a server for their friends, they can do whatever they want through the simplest UI and UX possible.
- **The same thing works the same way.** Before deciding how something behaves, find where Blockly already handles the same situation and do it that way, rather than inventing a second way ([CLAUDE.md](CLAUDE.md)).

## The name

Players know this product as **Cubepals**, at `cubepals.com`. **Blockly** is its codename.

- **What a person can see says Cubepals.** That covers page copy, titles, emails, error messages, in-game text such as the MOTD, the brand files, the films and the ads. Write "Cubepals" in sentences and **cubepals**, lowercase, in the wordmark. The possessive takes an apostrophe only: "Cubepals’ own machines".
- **The domain is `cubepals.com`, and nothing else.** The site is `cubepals.com`, realtime is `rt.cubepals.com`, and players join `<slug>.play.cubepals.com` (`PLAY_DOMAIN=play.cubepals.com`). Staging is `staging.cubepals.com`, with `rt.` and `play.` under it.
- **The repository is `cubepals/cubepals`.** Links to it, and anything that names it (Terraform's `repository`, CI), use that. blocklyd, the node daemon, is `cubepals/blocklyd`, under FSL-1.1-ALv2; this repository pins one of its releases (`bun scripts/blocklyd.ts`) and never copies its code.
- **Everything else stays Blockly.** That covers packages and workspaces (`@blockly/*`), `blocklyd` and other binaries, directories, env var names, database objects, Fly apps and orgs, Terraform resources, internal identifiers, code comments, docs under `docs/` and test names. Don't rename them to match the public name.
- **When it isn't clear whether a string is seen,** ask a maintainer rather than guess.

## Business internals stay private

Fraud and abuse tuning, costs and margins, competitors, pricing history, strategy and vendor trials never go in this repository, its commits, PRs or issues: code reads such numbers from private configuration, with a harmless default ([CLAUDE.md](CLAUDE.md)).

Nor does anything about a maintainer personally: their other work, their accounts, and the tools and connectors a session happens to have.

## The website's runtime

`next` and `@opennextjs/cloudflare` move together, only for a security fix or a feature the site needs, and merge only after the pull request's staging preview serves the site's pages ([CLAUDE.md](CLAUDE.md)).

## No accidental mentions

Never put `@` before a name in a commit message or a PR body, not even inside backticks. Commits do not render markdown, and a squash merge copies the PR body into the commit, so `@s` becomes a mention of the GitHub user "s". Write "the s selector" or "the player" instead. In issues and comments, selectors, package scopes and emails go inside backticks closed on the same line.

## Guides

Every guide on the site shows the screens it walks through. A guide is written with its pictures, not before them, and isn't approved without them.

- **Taken from a local stack** (`bun run dev`, `bun run dev:accounts`), in the light theme at 1×, cropped to what the step shows: a card, a question, a button, not the whole page.
- **Kept beside the guide,** under `apps/web/public/guides/<slug>/`, and shown with `Shot` at the size the file is, with alt text that says what is in it. Where the page renders a number from the plan table, the alt text names none.
- **Addresses read as players see them:** `<slug>.play.cubepals.com` (`PLAY_DOMAIN=play.cubepals.com` on the control plane). `maple-hollow` is kept for Cubepals' own images.
- **A picture goes stale with its screen.** A change to a screen a guide shows takes the picture again.

`guides.test.ts` holds every guide to at least one picture, each a file at the size its page gives it.

## Titles and slips

A PR or commit title says what changed, plainly, the way someone reading the history wants it. It doesn't state the motive. When something public goes wrong (a title, a mention, a post), stop, say what happened, and ask; don't close, reopen or force-push to cover it.

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
- **Durations:** no unit of time written out (a day in milliseconds, `60 * 60 * 1000` and the like); they come from `@blockly/contracts/durations`.
- **Attributed:** no comment saying who decided something, or the date it was decided. A comment says why, as fact.

It is a ratchet. What broke a rule before the rule existed is in `scripts/structure-baseline.json`, with its number and why. A check fails when anything gets worse, and when an entry is out of date. The baseline only shrinks: `--update` lowers its numbers and never adds one. Nobody fixes old code to get a change through, and nobody adds a baseline entry without saying why in it.

The checks stop things getting worse. They can't tell whether a seam is in the right place. That is on whoever makes the change, human or agent, with nobody reviewing behind them.

**The care.** A person who has never seen Blockly should be able to find where a thing lives, trust that the file holds one job, and change it without reading ten other files or breaking a neighbor. Split by what changes together, not by what is easy to cut. One job per file, nameable without "and", and named for the job, not a category. Don't split too far: ten tiny files that must all be opened to follow one flow are worse than one honest file. Dependencies point one way. The surface stays narrow and the same: what was private stays private, and what outsiders import keeps its old path. The header and the directory index say what each file is for and what it is deliberately not for, short and true, for someone who hasn't read the rest. Discipline over cleverness: if you are unsure where something belongs, leave it where it was and report it.

**Chosen and dropped files** are read in the website only through `apps/web/src/lib/chosen-files.ts`, which copies the browser's list before it empties; `bun run lint` fails on any other read (`apps/web/live-file-lists.grit`).

## Values from elsewhere

A value that belongs to another system is taken from that system, never typed out again. That covers a library's error codes and messages, a protocol's numbers (tRPC's JSON-RPC codes, Postgres' SQLSTATEs, HTTP statuses), an API's shapes, and another module's enum or limit.

- **Import it** from the library or module that defines it.
- **Tests get errors and answers from the real thing:** the real library, or a real instance of it, such as a tRPC refusal from the control plane's own router (`@blockly/control/testing/refusing`) or a unique violation from Postgres itself. A shape built by hand still passes after the real one has changed.
- **When nothing exports it,** as with a value only an API's documentation gives, it is one named constant in one place, with a comment saying where it comes from.

`bun run check:structure` finds JSON-RPC error numbers and SQLSTATE strings written out as literals, and units of time written out instead of imported from `@blockly/contracts/durations`.

## Autonomy

An agent a maintainer runs takes its work end to end, on the maintainer's access. It doesn't hand back a step it can take.

- **Codex reviews its pull requests, once a commit.** Codex's summary comment on the pull request says which commit it is reviewing or reviewed. After a push, the agent waits a minute; if that comment doesn't show the new head running or done, it comments `@codex review`, and never asks again for a commit Codex already has. It answers Codex like a person: each finding (Codex's line comments, P0 and P1) is fixed, or answered on its thread with why not, before it merges, and a fixed finding's thread is resolved, since Codex counts an open thread as an open finding. Codex is done when its summary comment says so: 👍 with no findings, or findings the agent dealt with and the fix reviewed. The second eye takes Codex's answer as its verdict and runs Claude only when Codex didn't answer for the commit, so the two never review the same commit both.
- **It merges its own pull request** once CI's `check` and the Second eye gate pass, and, for the website's runtime, once the staging preview serves its pages. It squash-merges with the expected head. An open pull request is unfinished work: it merges, or it closes with the reason and what replaces it.
- **It fixes main.** A red run on `main`, a nightly or a scheduled run is its to fix when it finds one, in a pull request of its own.
- **It deploys production** after its change merges and a nightly has passed with it ([Production](#production)).
- **It changes the repository's settings** in `.github/settings/`: rulesets in `rulesets/`, branch protection in `branches/`. A merge applies them (`repo-settings.yml`, with the Cubepals app's token), and `export` prints what is live. A ruleset or protection changed by hand is undone by the next apply; change the file.
- **It decides what the core rule leaves to Blockly,** says in the pull request what it chose and why, and moves on. It asks a maintainer only for money, anything one-way on production or its data, anything public that speaks for Cubepals, and the steps this guide reserves (`staging.ts down`, rewriting published history).

This is for agents the maintainer runs. A pull request from anyone else gets no secret, no deploy and no second eye, and only a maintainer merges it.

## Guardrails

What keeps an agent with that access from making work for the maintainer:

- **No new gate without asking.** A new required check, CI job or test system (coverage, mutation testing, baselines) is a maintainer's decision. CI's time is a budget: a change that slows a pull request's CI says by how much, and one that adds more than a minute asks first.
- **A change does what its title says.** What a player sees, what the edge caches and what a plan includes change only in a pull request whose title says so. A refactor or cleanup keeps behavior.
- **One change per pull request, from main.** A branch doesn't build on another open pull request's branch. It waits for that one to merge, then brings in main.
- **Fix forward, small.** A bug in merged work gets its own pull request, with a test that fails without the fix.
- **Only what is true.** A pull request or commit says what changed and how it was checked. It never claims an approval, review or authorization nobody gave, and never says a check passed that didn't run.
- **Stuck is a report, not a loop.** After three tries at the same failure, stop pushing: write down what fails, what was tried and what it looks like, and ask.

## Money

Code that charges, refunds, ends or cancels what a person paid for is held to more than the rest: `apps/control/src/app/billing/`, `apps/control/src/infra/polar/`, `apps/control/src/domain/account/`, the billing tables, and the pages that take a payment. Whoever changes it checks each rule below before opening the pull request and says in it which applied. A reviewer checks each again.

- **Every charge is accounted for.** What ends, cancels or refunds a purchase finds every order that paid for it: the first, a change of plan or price charged at once, a renewal. Each is included or left out for a stated reason, on the page, in the amount and in what the operators are told. Nothing paid is ended without its refund being asked for. A new call to the provider says what a cancel does with what it charges (`billing/charges.test.ts` doesn't compile until it does).
- **Decide on what is read under the lock.** A check made before a call to the provider, or before a lock is taken, is made again inside the transaction, on rows read there. What arrived in between, a refund or a second request, refuses or changes the answer.
- **Nothing leaves before the commit unless its failure is handled.** A call to the provider made before the transaction that records it has its failure afterwards reported with the ids, and a retry that works and is tested. An email sent inside a transaction says in its comment that it is sent at least once, and why that is the safer side.
- **One way to retry.** What couldn't be sent is marked in the database and sent by the billing pass (`standing-sweep`). The provider's delivery never fails because of an email.
- **A pass isn't held by its head.** A periodic pass that takes the oldest rows can't be filled by rows that will never succeed: they are passed over, or said once.
- **Once says what counts.** A rule that holds once per person, per order or per account says what counts toward it and what doesn't (a correction, a duplicate, something that never started), with a test for each.
- **What stops is judged again.** Whatever stops something paid for names every account it moved, and their limits are judged at once, not at the next pass.
- **One amount, said one way.** The page, the emails and what is kept say the same amount, in the order's currency, through the same function.
- **Both sides of each line are tested,** and a spy shows that nothing pays money out. No new path pays money out unless the pull request's title says it does.

## Code Review Rules

What a reviewer of a pull request here reports, Codex's GitHub review included, and what the second eye's Claude checks too (`.github/second-eye.md`). Only what was checked against the code and is wrong:

- **Bugs:** wrong behaviour, broken edge cases, races, errors swallowed.
- **Security:** access checks, secrets, injection, untrusted input.
- **Data or money:** data lost or corrupted, migrations, billing, hours. On a change to the code [Money](#money) names, each of its rules, one by one.
- **This guide's rules:** the core rule, the name rules, the structure rules, and business internals put anywhere public.

Never praise, a summary of the diff, style, or anything CI already reports.

## CI

A change isn't done when its PR is green. It is done when the runs it starts on `main` are green too.

**Every new commit is signed.** Enable `git config --local commit.gpgsign true` before committing.
Never disable signing or create an unsigned interim commit. If this machine has no signing key,
use `bun scripts/quality/signed-commit.mjs "Subject"` with authenticated GitHub access; it signs as the
authenticated account and verifies the complete staged tree. Never generate a replacement user
key. Before pushing, verify every PR commit. Rewrite published history only with explicit user
authorization and an expected-head check; leave merged history alone.

- **Workflows are code.** A change to `.github/workflows/` passes `actionlint` before it is pushed, and CI runs it again. A workflow GitHub can't parse never runs and shows only a red run named by its path.
- **Subjects are short.** A commit subject or pull request title says the change in 50 characters or fewer, with no closing period; the detail goes in the body. The `commit-msg` hook that `bun install` sets up and the `PR title` workflow enforce it.
- **After a merge, look at the Actions page,** not only the PR's checks: `gh run list -R cubepals/<repo> -L 30`. Scheduled runs (the nightly, the weekly fleet run) fail without a PR to show it.
- **A failure outside the code is still a failure.** A registry's rate limit or an outage gets a fix (a mirror, a retry), not a rerun until it passes.

## Production

Production deploys from the **Deploy production** workflow, on GitHub's machine ([docs/production.md](docs/production.md#deploy-from-github)). An agent deploys it itself, when a maintainer asks and after its own change merges: it runs the workflow and sees it through, rather than handing the button back.

- **Only what staging proved.** `apply` takes a commit a nightly passed on staging: the newest, unless one is named. A change that can't wait for tonight's takes the hot path, `ship now`: `gh workflow run deploy-production.yml -f "command=ship now"` takes the road main's guard finds for it ([docs/production.md](docs/production.md#routes)): nothing for prose and tests alone; the website alone, with no nightly, once its pull request merged up to date with main after CI passed and its preview answered; otherwise the nightly at once and `apply` when it passes ([CLAUDE.md](CLAUDE.md#shipping-to-production)).
- **See it through.** Watch the run to the end, ask production for `/`, `/pricing`, `/sign-in` and `/api/health`, and say what went out.
- **Back first, cause after.** If production fails after a deploy, run the workflow's `rollback` at once, then find the cause.
- **Values live in the private records,** in the encrypted bundle the workflow opens. A value changed anywhere else is lost; change it there. Never print one.
- **Why someone is having a bad time** is answered from the operators' API, for one account, a group or the whole platform: `ops.ts diagnose <email>` first ([docs/diagnosis.md](docs/diagnosis.md)).
- **What production does is in PostHog.** The control plane and the website send their events and errors to the project in PostHog's EU cloud ([docs/configuration.md](docs/configuration.md)); production alone sends any. It is the project's only analytics and observability service. Another such service a session can reach isn't Cubepals': never read Cubepals' data from it, send any to it, or name it here.

## Staging

Staging runs on Fly in the `blockly-staging` org, and it stays. When nobody is testing, its machines are stopped, not destroyed.

- **Start it before testing:** `bun scripts/staging.ts start`. **Stop it after:** `bun scripts/staging.ts stop`, and check that it reports every machine as stopped, the database's included. `status` shows what exists and where to reach it.
- **Its database** is Postgres on a Fly Machine of its own, the app `bly-staging-db`, in the control plane's region. `start` starts it first and waits until it accepts connections; `stop` stops it last. It is private to the org: the scripts reach it through `fly proxy`. It isn't backed up, since staging is seeded again. `STAGING_DATABASE=supabase` switches back to the Supabase project.
- **Deploy a branch to it:** `bun scripts/staging.ts up`. It makes only what is missing and deploys this checkout. **Check it end to end:** `bun scripts/staging-check.ts`.
- **Never run `bun scripts/staging.ts down`** unless a maintainer asks for exactly that. It destroys staging, its database and worlds included.
- **In a cloud environment,** its variables (`FLY_API_TOKEN`, `POLAR_*`, `STAGING_STATE`) stand in for a maintainer's machine. Never print these values, and never put them in a commit, a PR or a message. If `fly` or `bun` is missing or not 1.4.3, the environment's setup script didn't run. Say so rather than working around it.
