<!-- The rules live in AGENTS.md, which every agent and person reads; Claude Code reads it through this import. The sections below are the full form of three of them. -->
@AGENTS.md

## Business internals stay private

The repository is public, and so are its commits, pull requests and issues. Business internals never go in any of them:

- fraud and abuse weights, thresholds and signal tuning;
- costs, margins, and what a plan earns;
- competitors;
- pricing history, and why a price is what it is;
- strategy and vendor trials;
- anything about a maintainer personally: their other work, their accounts, and the tools and connectors a session happens to have.

They live in the private records repository or in private configuration. Code keeps the mechanism and reads such numbers from private configuration, an env var or a Fly secret (`FREE_LINK_TUNING`, `ABUSE_LIMITS`), with a harmless default for development and tests. Public prices are what the pricing page shows.

## The same thing works the same way

A player meets one product, not one per pull request. Before deciding how something behaves, find where Blockly already handles the same situation, read that code, and do it that way.

- **Look first.** The situations that come up most, and how Blockly handles each today:
  - **Someone or something isn't there right now:** the player is away, or the server is asleep. The player page keeps the ask for their next join, says so, and lets it be taken back (`app/players/`). Access changes wait for the server's next start.
  - **Something can't be undone:** a copy is kept first, with a way back. Examples are the safety backups before a change, the inventory kept before a clear, and the trash before a delete.
  - **How it reads on the page:** the same words, the same waiting line with Cancel, the same confirmation before what is destructive.
- **Apply it; don't invent another.** A new control doesn't get its own rule for when it works, its own kind of undo or its own wording when one already exists. It isn't hidden, or limited to "while they play", when the controls beside it wait instead. Limit it only where it means nothing later, and say why on the page.
- **Where the existing way doesn't fit,** say why in the pull request. Then either change it everywhere it applies, or leave it alone. Two ways of doing the same thing is a bug.

## The website's runtime moves only when proven

The website is a Next.js app that runs as a Cloudflare Worker through an adapter. A build can pass every test and still fail every request once it runs as a Worker, so what runs it is held to a higher bar than any other dependency.

- **Next and its adapter move together.** `next` and `@opennextjs/cloudflare` change in one pull request, to versions the adapter supports, never one alone. `wrangler` goes with them when the adapter asks for a newer one.
- **Only with a reason.** A Next.js release is taken for a security fix or a feature the site needs, not because it is newer. It never merges itself.
- **Proven on staging before it merges.** The pull request's preview (`pr-<n>.preview.cubepals.com`) answers 200 on `/`, `/pricing`, `/sign-in`, `/browse` and an image under `/_next/image`, and CI's Worker build is green. Passing tests alone aren't proof.
- **Back first, cause after.** If the website fails after a deploy, it goes back to the last good version at once, and the cause is found after.
