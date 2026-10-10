/**
 * Which changes may reach production by which road, judged from the paths a deploy carries:
 *
 * - the website alone (`production.ts web`): nothing the Fly apps are built from changed, so
 *   Vercel's build is all it takes;
 * - a hotfix (`production.ts hotfix`): the Fly apps the change is built into, and only those,
 *   and never a Terraform change, which goes through `apply`.
 *
 * This file only judges paths; the commands are production.ts's.
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

/** What each Fly app is built from beyond what they all share (packages, the lockfile). */
const APP_INPUTS: Record<FlyApp, RegExp[]> = {
  control: [/^apps\/control\//, /^infra\/fly\/control\.toml$/],
  realtime: [/^apps\/control\//, /^infra\/fly\/realtime\.toml$/],
  edge: [/^apps\/edge\//, /^infra\/fly\/edge\.toml$/],
}
const SHARED_INPUTS = [/^packages\//, /^package\.json$/, /^bun\.lock$/]

export type FlyApp = 'control' | 'realtime' | 'edge'

/** The changed paths that ship to Fly; none means the website can go on its own. */
export function flyInputs(paths: readonly string[]): string[] {
  return paths.filter((path) => FLY_INPUTS.some((input) => input.test(path)))
}

/** The Fly apps a change is built into, control first: its release runs the migrations. */
export function appsFor(paths: readonly string[]): FlyApp[] {
  const touches = (inputs: RegExp[]) => paths.some((path) => inputs.some((input) => input.test(path)))
  return (['control', 'realtime', 'edge'] as const).filter((app) =>
    touches([...APP_INPUTS[app], ...SHARED_INPUTS]),
  )
}

/** Whether a change reaches the website: its own code, or a package it is built with. */
export const reachesWebsite = (paths: readonly string[]): boolean =>
  paths.some((path) => /^apps\/web\//.test(path) || /^packages\//.test(path))

/** The Terraform a change carries, which only `apply` puts in place. */
export const terraformIn = (paths: readonly string[]): string[] =>
  paths.filter((path) => /^infra\/terraform\//.test(path))
