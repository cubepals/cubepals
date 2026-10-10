/**
 * Which changes may reach production as the website alone (`bun scripts/production.ts web`):
 * Vercel builds cubepals.com from the `production` branch, so a change that only the website runs
 * needs no staging pass and no Fly deploy. Anything the Fly apps are built from does, and goes
 * through `apply` and the nightly instead. This file only judges paths; the command is
 * production.ts's.
 */

/** What the Fly apps (control, realtime, edge) are built from, so a change to it is theirs too. */
const FLY_INPUTS = [
  /^apps\/control\//,
  /^apps\/edge\//,
  /^packages\//,
  /^infra\/fly\//,
  /^package\.json$/,
  /^bun\.lock$/,
] as const

/** The changed paths that ship to Fly; none means the website can go on its own. */
export function flyInputs(paths: readonly string[]): string[] {
  return paths.filter((path) => FLY_INPUTS.some((input) => input.test(path)))
}
