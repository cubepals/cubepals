// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which changes may reach production by which road, judged from the paths a deploy carries:
 *
 * - the website alone (`production.ts web`): nothing the Fly apps are built from changed, so
 *   the website's own build and deploy is all it takes;
 * - a hotfix (`production.ts hotfix`): the Fly apps the change is built into, and only those,
 *   and never a Terraform change, which goes through `apply`.
 *
 * Which Fly apps a path is built into comes from what their Dockerfiles copy. This file only
 * judges paths; the commands are production.ts's.
 */

import { readFileSync } from 'node:fs'

export type FlyApp = 'control' | 'realtime' | 'edge'

const ROOT = new URL('../', import.meta.url)

/** Each Fly app's image and its Fly config; control and realtime run the same image. */
const BUILDS: Record<FlyApp, { dockerfile: string; config: string }> = {
  control: { dockerfile: 'apps/control/Dockerfile', config: 'infra/fly/control.toml' },
  realtime: { dockerfile: 'apps/control/Dockerfile', config: 'infra/fly/realtime.toml' },
  edge: { dockerfile: 'apps/edge/Dockerfile', config: 'infra/fly/edge.toml' },
}

/**
 * What a Dockerfile copies from the build context (the repository root): each COPY's sources,
 * files or directories, leaving out copies from another stage or image. Read from the Dockerfile
 * itself, so a file an image starts copying is a reason to redeploy it from then on.
 */
function copiedFrom(dockerfile: string): string[] {
  return dockerfile
    .replaceAll(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^COPY\s/i.test(line))
    .flatMap((line) => {
      const words = line.split(/\s+/).slice(1)
      if (words[0]?.startsWith('[')) throw new Error(`A COPY in JSON form isn't read here: ${line}`)
      if (words.some((word) => word.startsWith('--from='))) return []
      return words.filter((word) => !word.startsWith('--')).slice(0, -1)
    })
    .map((source) => source.replace(/^\.\//, '').replace(/\/$/, ''))
}

/** What each Fly app is built from: its image's sources, its Dockerfile and its Fly config. */
const APP_INPUTS = Object.fromEntries(
  Object.entries(BUILDS).map(([app, { dockerfile, config }]) => [
    app,
    [...copiedFrom(readFileSync(new URL(dockerfile, ROOT), 'utf8')), dockerfile, config],
  ]),
) as Record<FlyApp, string[]>

/**
 * Whether a deploy has anything to put on `app`, given the paths that differ between the commit
 * its running release was built from and this one: its image's sources, Dockerfile or Fly config.
 */
export const changedFor = (app: FlyApp, paths: readonly string[]): boolean =>
  paths.some((path) => within(path, APP_INPUTS[app]))

/** Whether a path is one of the inputs, or inside one that is a directory. */
const within = (path: string, inputs: readonly string[]): boolean =>
  inputs.some((input) => path === input || path.startsWith(`${input}/`))

/** The changed paths that ship to Fly; none means the website can go on its own. */
export function flyInputs(paths: readonly string[]): string[] {
  const all = Object.values(APP_INPUTS).flat()
  return paths.filter((path) => within(path, all))
}

/** The Fly apps a change is built into, control first: its release runs the migrations. */
export function appsFor(paths: readonly string[]): FlyApp[] {
  return (['control', 'realtime', 'edge'] as const).filter((app) =>
    paths.some((path) => within(path, APP_INPUTS[app])),
  )
}

/** Whether a change reaches the website: its own code, or a package it is built with. */
export const reachesWebsite = (paths: readonly string[]): boolean =>
  paths.some((path) => /^apps\/web\//.test(path) || /^packages\//.test(path))

/** The Terraform a change carries, which only `apply` puts in place. */
export const terraformIn = (paths: readonly string[]): string[] =>
  paths.filter((path) => /^infra\/terraform\//.test(path))
