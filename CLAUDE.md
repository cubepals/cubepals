<!-- The rules live in AGENTS.md, which every agent and person reads; Claude Code reads it through this import. The sections below are the full form of two of them. -->
@AGENTS.md

## Business internals stay private

The repository is public, and so are its commits, pull requests and issues. Business internals never go in any of them:

- fraud and abuse weights, thresholds and signal tuning;
- costs, margins, and what a plan earns;
- competitors;
- pricing history, and why a price is what it is;
- strategy and vendor trials.

They live in the private records repository or in private configuration. Code keeps the mechanism and reads such numbers from private configuration, an env var or a Fly secret (`FREE_LINK_TUNING`, `ABUSE_LIMITS`), with a harmless default for development and tests. Public prices are what the pricing page shows.

## The website's runtime moves only when proven

The website is a Next.js app that runs as a Cloudflare Worker through an adapter. A build can pass every test and still fail every request once it runs as a Worker, so what runs it is held to a higher bar than any other dependency.

- **Next and its adapter move together.** `next` and `@opennextjs/cloudflare` change in one pull request, to versions the adapter supports, never one alone. `wrangler` goes with them when the adapter asks for a newer one.
- **Only with a reason.** A Next.js release is taken for a security fix or a feature the site needs, not because it is newer. It never merges itself.
- **Proven on staging before it merges.** The pull request's preview (`pr-<n>.preview.cubepals.com`) answers 200 on `/`, `/pricing`, `/sign-in`, `/browse` and an image under `/_next/image`, and CI's Worker build is green. Passing tests alone aren't proof.
- **Back first, cause after.** If the website fails after a deploy, it goes back to the last good version at once, and the cause is found after.
