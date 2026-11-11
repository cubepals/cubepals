// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which road a change takes to production, decided from the paths that differ between what
 * production runs (the `production` branch) and the commit to deploy (docs/production.md § Routes):
 *
 * - `none`: only prose or tests changed. Nothing runs differently, so nothing is deployed.
 * - `website`: only the website's own code (apps/web). The website alone goes.
 * - `control`: only what the control and realtime apps are built from. Those apps alone go.
 * - `edge`: only what the edge is built from. The edge alone goes.
 * - `full`: anything else, or more than one of the above: the nightly and `apply`, as always.
 *
 * Each path takes the first rule in RULES it matches; a path no rule names is `full`. A change
 * whose paths fall in more than one area is `full` too. So a wrong guess fails closed: what isn't
 * known to be narrow takes the whole path.
 *
 * Which Fly app a path is built into comes from production-web.ts, which reads it from the
 * Dockerfiles. The second eye's sensitive paths (second-eye-gate.ts) answer who reviews a change,
 * not what deploys it, so they aren't read here. Only node's own modules and files beside it:
 * main's guard imports this without an install.
 */
import { spawnSync } from 'node:child_process'
import { appsFor, flyInputs, terraformIn } from './production-web.ts'

export type Route = 'none' | 'website' | 'control' | 'edge' | 'full'

/** The area one path belongs to, and why, in words a run summary can show. */
type Rule = { area: Route | 'app'; test: (path: string) => boolean; why: string }

/** Prose and what only the repository reads, as CI's "Find what changed" skips them. */
const PROSE = [
  /^docs\//,
  /^brand\//,
  /^LICENSES\//,
  /\.md$/,
  /^(REUSE\.toml|CITATION\.cff)$/,
  /^\.github\/(ISSUE_TEMPLATE\/|CODEOWNERS$|pull_request_template\.md$|dependabot\.yml$|settings\/)/,
]

/**
 * In order; the first that matches a path decides it. Tests come first: nothing a test file holds
 * runs in production. What every part is built from (packages, the lockfile, any package.json),
 * Terraform, the workflows and the deploy scripts come next, so that nothing narrower can claim
 * them. The Worker's own config names the bindings and resources Terraform owns. Prose comes after
 * the apps, so a file an image copies (a picture under brand/) is the image's.
 */
const RULES: readonly Rule[] = [
  { area: 'none', test: (p) => /\.test\.tsx?$/.test(p), why: 'a test' },
  { area: 'full', test: (p) => /^packages\//.test(p), why: 'a shared package, or a migration' },
  {
    area: 'full',
    test: (p) => /(^|\/)(package\.json|bun\.lock|bunfig\.toml)$/.test(p),
    why: 'dependencies, which every part is built with',
  },
  { area: 'full', test: (p) => /^infra\/terraform\//.test(p), why: 'Terraform' },
  { area: 'full', test: (p) => /^\.github\/workflows\//.test(p), why: 'a workflow' },
  { area: 'full', test: (p) => /^scripts\//.test(p), why: 'the scripts that build and deploy' },
  {
    area: 'full',
    test: (p) => p === 'apps/web/wrangler.jsonc',
    why: "the Worker's bindings, whose resources Terraform owns",
  },
  { area: 'app', test: (p) => flyInputs([p]).length > 0, why: 'what a Fly app is built from' },
  { area: 'website', test: (p) => /^apps\/web\//.test(p), why: "the website's own code" },
  { area: 'none', test: (p) => PROSE.some((pattern) => pattern.test(p)), why: 'prose' },
]

/** The Fly app area a path is built into: one app's own, or `full` when it reaches more than one. */
function appArea(path: string): Route {
  const apps = appsFor([path])
  if (apps.length > 0 && apps.every((app) => app === 'control' || app === 'realtime')) return 'control'
  if (apps.length === 1 && apps[0] === 'edge') return 'edge'
  return 'full'
}

/** One path's area, and the rule that decided it. */
export function areaOf(path: string): { area: Route; why: string } {
  const rule = RULES.find((r) => r.test(path))
  if (rule === undefined) return { area: 'full', why: 'no narrower road knows it' }
  return { area: rule.area === 'app' ? appArea(path) : rule.area, why: rule.why }
}

/**
 * What stops the website going alone (`production.ts web`), among the paths since the last deploy:
 * Terraform, and what the Fly apps are built from. A path the route counts as `none` (a test,
 * prose) runs nothing in production, so it stops nothing here either.
 */
export function besideTheWebsite(paths: readonly string[]): { terraform: string[]; fly: string[] } {
  const runs = paths.filter((path) => areaOf(path).area !== 'none')
  return { terraform: terraformIn(runs), fly: flyInputs(runs) }
}

export interface Decision {
  route: Route
  /** Each area the change reaches, with a few of its paths: what the run says it chose and why. */
  areas: { area: Route; paths: string[] }[]
}

/** The road for a change, from every path it differs in. No path at all is `none`. */
export function routeOf(paths: readonly string[]): Decision {
  const byArea = new Map<Route, string[]>()
  for (const path of paths) {
    const { area } = areaOf(path)
    byArea.set(area, [...(byArea.get(area) ?? []), path])
  }
  const areas = [...byArea].map(([area, of]) => ({ area, paths: of }))
  const reached = areas.map((a) => a.area).filter((area) => area !== 'none')
  const route: Route = reached.length === 0 ? 'none' : reached.length === 1 ? (reached[0] as Route) : 'full'
  return { route, areas }
}

/**
 * The paths that differ between two commits in `repo`, each side of a rename counted, so a file
 * moved out of a package still counts as the package's. Null when git can't tell, which the
 * caller takes as `full`.
 */
export function pathsBetween(repo: string, from: string, to: string): string[] | null {
  const diff = spawnSync('git', ['-C', repo, 'diff', '--no-renames', '--name-only', from, to], {
    encoding: 'utf8',
  })
  if (diff.status !== 0) return null
  return diff.stdout.split('\n').filter(Boolean)
}

/** What a run summary says of a decision: the route, then each area with a few of its paths. */
export function describeRoute(decision: Decision): string[] {
  const shown = (paths: string[]) =>
    paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, and ${paths.length - 5} more` : '')
  return [
    `Route: ${decision.route}.`,
    ...decision.areas.map(({ area, paths }) => `  ${area}: ${shown(paths)}`),
  ]
}
