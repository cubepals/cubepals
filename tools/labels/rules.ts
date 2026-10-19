// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every label a pull request or issue carries, and the rules that choose them from what the
 * change touches. Pure: no network, no clock, so the workflow, the daily sweep, the backfill and
 * the tests all decide the same way. cli.ts reads GitHub and writes the result.
 *
 * Families: exactly one `kind/`, one or more `area/`, exactly one `size/` on a pull request; one
 * `impact/`; any `risk/`. An issue gets a `kind/`, its `area/`s and `needs-triage` until it has
 * both. Rules decide first; a model may only choose among the names below, and only for what
 * rules can't know (a vague title's kind, whether players see it, an issue's area).
 */

export type Label = { name: string; color: string; description: string }

const kinds = {
  'kind/feature': 'New or changed behaviour, page or wording',
  'kind/bug': 'Something that worked wrong now works right',
  'kind/perf': 'Faster or lighter, behaviour unchanged',
  'kind/hardening': 'Sturdier against bad input, outages or mistakes',
  'kind/refactor': 'Code moved or reshaped, behaviour unchanged',
  'kind/docs': 'Documentation only',
  'kind/deps': 'A dependency or pinned version moves',
  'kind/chore': 'CI, tooling, tests or housekeeping',
} as const

const areas = {
  'area/web': 'The website and its pages (apps/web)',
  'area/control': 'The control plane (apps/control)',
  'area/minecraft': 'What runs inside a Minecraft server: packs, datapacks, our servers',
  'area/edge': 'The edge: joins, routing and waking (apps/edge)',
  'area/realtime': 'Live updates between the site and servers',
  'area/fleet': 'Where servers run: machines, nodes and runtimes',
  'area/billing': 'Plans, payments and hours',
  'area/db': 'The database schema and migrations (packages/db)',
  'area/contracts': 'Types shared between the apps (packages/contracts)',
  'area/infra': 'Deploys, Terraform and production or staging scripts',
  'area/ci': 'CI, hooks and repository-wide build settings',
  'area/scripts': 'Developer and operations scripts (scripts)',
  'area/devtools': 'Developer tools and experiments',
  'area/docs': 'Documentation, brand and licensing files',
} as const

const sizes = {
  'size/XS': '0-9 lines changed',
  'size/S': '10-29 lines changed',
  'size/M': '30-99 lines changed',
  'size/L': '100-499 lines changed',
  'size/XL': '500-999 lines changed',
  'size/XXL': '1000 or more lines changed',
} as const

const impacts = {
  'impact/players': 'Players or server owners see or feel this',
  'impact/internal': 'Nothing a player sees changes',
} as const

const risks = {
  'risk/migration': 'Changes the database schema',
  'risk/billing': 'Touches plans, payments or hours',
  'risk/staging': 'Worth a look on staging before production',
} as const

const statuses = {
  'needs-triage': 'Waiting for a kind and an area',
  'status/accepted': 'We mean to do this',
  'status/needs-info': 'Waiting on the person who opened it',
  'status/duplicate': 'Covered by another issue or pull request',
  'status/not-planned': 'Not something we will do',
  'good first issue': 'Good for a first contribution',
  'help wanted': 'Open for anyone to take',
  accessibility: 'Barrier affecting people with disabilities',
} as const

export type Kind = keyof typeof kinds
export type Area = keyof typeof areas
export type Size = keyof typeof sizes
export type Impact = keyof typeof impacts
export type Risk = keyof typeof risks

/** One colour a family, so a list of labels reads by family at a glance. */
const colors = {
  kind: '3a2e8f',
  area: '0e6e5c',
  size: 'c9c9c9',
  impact: 'e0a526',
  risk: 'b60205',
  status: '5319e7',
} as const

const family = (entries: Record<string, string>, color: string): Label[] =>
  Object.entries(entries).map(([name, description]) => ({ name, color, description }))

export const LABELS: Label[] = [
  ...family(kinds, colors.kind),
  ...family(areas, colors.area),
  ...family(sizes, colors.size),
  ...family(impacts, colors.impact),
  ...family(risks, colors.risk),
  ...family(statuses, colors.status).map((label) =>
    label.name === 'good first issue'
      ? { ...label, color: '7057ff' }
      : label.name === 'help wanted'
        ? { ...label, color: '008672' }
        : label.name === 'accessibility'
          ? { ...label, color: 'f143ab' }
          : label,
  ),
]

/** Old names renamed in place, so each keeps its history on past issues and pull requests. */
export const RENAMES: Record<string, string> = {
  bug: 'kind/bug',
  enhancement: 'kind/feature',
  documentation: 'kind/docs',
  dependencies: 'kind/deps',
}

/** GitHub's defaults nothing here uses, deleted by the sync once nothing carries them. */
export const RETIRED = ['duplicate', 'invalid', 'question', 'wontfix'] as const

export const KINDS = Object.keys(kinds) as Kind[]
export const AREAS = Object.keys(areas) as Area[]
export const SIZES = Object.keys(sizes) as Size[]
export const IMPACTS = Object.keys(impacts) as Impact[]
export const RISKS = Object.keys(risks) as Risk[]

// ---------------------------------------------------------------------------------------------
// Paths to areas. Each file belongs to the first area whose pattern matches it, so a file in
// apps/control/src/minecraft is minecraft, not control. Every file matches something: the last
// rule catches the rest as ci (the repository's own build settings).

const AREA_RULES: [Area, RegExp][] = [
  // A README beside code belongs to that code's area; only the repository's own documents are docs.
  [
    'area/docs',
    /^[^/]+\.md$|^docs\/|^brand\/|^LICENSES\/|^(LICENSE|NOTICE|REUSE\.toml|CITATION\.cff)$|^\.github\/[^/]+\.md$/,
  ],
  [
    'area/ci',
    /^\.github\/|^tools\/labels\/|^lefthook\.yml$|^scripts\/(check-|ci-comment|preview-|typecheck|structure-baseline)/,
  ],
  ['area/infra', /^infra\/|^scripts\/(production|staging|database-dump|fleet-hetzner|smoke)/],
  [
    'area/billing',
    /^apps\/control\/src\/(app|interfaces)\/billing\/|^apps\/control\/src\/infra\/(polar|local-billing)\/|^apps\/control\/src\/app\/emails\/billing\.|^packages\/db\/src\/schema\/billing\.|^packages\/contracts\/src\/(chip-in|coupons|gifts)\.|^apps\/web\/src\/app\/\(public\)\/(pricing|paying-for-others)\//,
  ],
  [
    'area/minecraft',
    /^apps\/control\/src\/minecraft\/|^apps\/control\/assets\/|^scripts\/(lib\/)?(arcade-|play-|server-icons|datapack-formats|protocols)/,
  ],
  [
    'area/edge',
    /^apps\/edge\/|^apps\/control\/src\/(app|interfaces)\/edge\/|^packages\/contracts\/src\/(edge|joins|proxy-header)/,
  ],
  [
    'area/realtime',
    /^apps\/control\/src\/(app|infra|interfaces)\/realtime\/|^packages\/contracts\/src\/realtime\./,
  ],
  [
    'area/fleet',
    /^apps\/control\/src\/infra\/(fleet|boat|fly|docker)\/|^apps\/control\/src\/app\/runtimes\/|^apps\/control\/src\/testing\/fleet\.|^scripts\/(fleet|blocklyd)/,
  ],
  ['area/db', /^packages\/db\//],
  ['area/contracts', /^packages\/contracts\//],
  ['area/web', /^apps\/web\//],
  ['area/control', /^apps\/control\//],
  ['area/devtools', /^apps\/devtools\/|^tools\/|^experimental\//],
  ['area/scripts', /^scripts\//],
  ['area/ci', /./],
]

export function areaOf(path: string): Area {
  for (const [area, pattern] of AREA_RULES) if (pattern.test(path)) return area
  return 'area/ci'
}

// ---------------------------------------------------------------------------------------------
// Size: lines added plus deleted, leaving out what .gitattributes marks linguist-generated (the
// migration snapshots alone are ~8,000 lines each) and binary files. Kubernetes' thresholds.

export type ChangedFile = { path: string; additions: number; deletions: number; status?: string }

/** The linguist-generated patterns of a .gitattributes file, as tests on a path. */
export function generatedMatchers(gitattributes: string): ((path: string) => boolean)[] {
  return gitattributes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /\slinguist-generated(\s|$|=true)/.test(line))
    .map((line) => globToRegExp(line.split(/\s+/)[0] ?? ''))
    .map((pattern) => (path: string) => pattern.test(path))
}

function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  // A pattern with no slash matches the name in any directory, as git's does.
  return new RegExp(glob.includes('/') ? `^${out}$` : `(^|/)${out}$`)
}

export function linesChanged(files: ChangedFile[], generated: ((path: string) => boolean)[]): number {
  return files
    .filter((f) => !generated.some((g) => g(f.path)))
    .reduce((n, f) => n + f.additions + f.deletions, 0)
}

export function sizeOf(lines: number): Size {
  if (lines < 10) return 'size/XS'
  if (lines < 30) return 'size/S'
  if (lines < 100) return 'size/M'
  if (lines < 500) return 'size/L'
  if (lines < 1000) return 'size/XL'
  return 'size/XXL'
}

// ---------------------------------------------------------------------------------------------
// Kind. Titles here are plain sentences ("Count wakes by finished joins"), never `feat:`
// prefixes, so the kind comes from who opened it, what it touches and the title's first verb.
// `sure` says whether a rule knew; when it didn't, a model may choose and this is the fallback.

const VERBS: [Kind, RegExp][] = [
  ['kind/deps', /^(Bump|Upgrade|Pin|Run \S+ \d+\.\d+)/],
  ['kind/refactor', /^(Move:|Rename|Split|Merge|Inline|Extract|Tidy|Reorganise|Reorganize)\b/],
  ['kind/bug', /^(Fix|Restore|Unstick|Repair|Correct|Recover|Undo|Revert)\b/],
  ['kind/perf', /^(Cut|Fewer|Speed|Faster|Cache|Share \S+ reads|Halve)\b/],
  ['kind/hardening', /^(Refuse|Bound|Limit|Cap|Guard|Reject|Validate|Check uploaded|Never let|Hold back)\b/],
  ['kind/docs', /^(Document|Explain|Describe)\b/],
  [
    'kind/feature',
    /^(Add|Give|Let|Show|Send|Draw|Link|Open|Brand|Light|Tell|Alert|Ask|Name|Assign|Report|Post|Offer|Support|Allow|Introduce|Start)\b/,
  ],
]

/** Kinds whose verbs are unambiguous here; the rest are a first guess a model may change. */
const SURE_VERBS = new Set<Kind>(['kind/deps', 'kind/refactor', 'kind/bug', 'kind/docs'])

export type PullRequest = {
  title: string
  body?: string
  author: string
  bot?: boolean
  files: ChangedFile[]
}

export type Decision = {
  kind: Kind
  kindSure: boolean
  areas: Area[]
  size: Size
  lines: number
  impact: Impact
  impactSure: boolean
  risks: Risk[]
}

const INTERNAL_AREAS = new Set<Area>(['area/docs', 'area/ci', 'area/scripts', 'area/devtools', 'area/infra'])
const isTest = (path: string) => /\.test\.tsx?$|\/testing\/|\/fixtures?\//.test(path)

export function kindOf(pr: PullRequest, fileAreas: Area[]): { kind: Kind; sure: boolean } {
  if (pr.author === 'dependabot[bot]') return { kind: 'kind/deps', sure: true }
  if (pr.title.startsWith('Move:')) return { kind: 'kind/refactor', sure: true }
  if (fileAreas.every((a) => a === 'area/docs')) return { kind: 'kind/docs', sure: true }
  if (fileAreas.every((a) => a === 'area/ci' || a === 'area/docs')) return { kind: 'kind/chore', sure: true }
  if (pr.files.every((f) => isTest(f.path))) return { kind: 'kind/chore', sure: true }
  // A verb settles the kind only where it can't mean two things: "Refuse a join the server can't
  // take" is a feature to the player who gets a reason, not hardening.
  for (const [kind, pattern] of VERBS) if (pattern.test(pr.title)) return { kind, sure: SURE_VERBS.has(kind) }
  // "Keep X ..." is this repository's commonest title and usually mends something that drifted.
  if (/^Keep\b/.test(pr.title)) return { kind: 'kind/bug', sure: false }
  if (/\b(test|tests|bench|benchmark|load test|measure)\b/i.test(pr.title))
    return { kind: 'kind/chore', sure: false }
  return { kind: 'kind/feature', sure: false }
}

export function impactOf(pr: PullRequest, fileAreas: Area[]): { impact: Impact; sure: boolean } {
  if (fileAreas.every((a) => INTERNAL_AREAS.has(a))) return { impact: 'impact/internal', sure: true }
  const shipped = pr.files.filter((f) => !isTest(f.path) && !INTERNAL_AREAS.has(areaOf(f.path)))
  if (shipped.length === 0) return { impact: 'impact/internal', sure: true }
  return { impact: 'impact/players', sure: false }
}

const MIGRATION = /^packages\/db\/(migrations\/[^/]+\.sql|src\/schema(\/|\.ts$))/
const STAGING =
  /^apps\/(edge|control)\/Dockerfile$|^apps\/control\/src\/main\.node\.ts$|^infra\/(fly|terraform)\/|^scripts\/(production|staging)/

export function risksOf(files: ChangedFile[], fileAreas: Area[]): Risk[] {
  const out = new Set<Risk>()
  if (files.some((f) => MIGRATION.test(f.path))) out.add('risk/migration')
  if (fileAreas.includes('area/billing')) out.add('risk/billing')
  const runtime = files.some(
    (f) => !isTest(f.path) && ['area/edge', 'area/fleet', 'area/realtime'].includes(areaOf(f.path)),
  )
  if (out.has('risk/migration') || runtime || files.some((f) => STAGING.test(f.path))) out.add('risk/staging')
  return RISKS.filter((r) => out.has(r))
}

/**
 * Files that ride along with changes elsewhere: the structure ratchet, lockfiles, the root
 * package.json and the migrations'
 * snapshots. They say nothing about where a change is, so they count for an area only when a pull
 * request is nothing else.
 */
const RIDE_ALONG =
  /^scripts\/structure-baseline\.json$|(^|\/)bun\.lock$|^package\.json$|^packages\/db\/migrations\/meta\//

export function decide(pr: PullRequest, generated: ((path: string) => boolean)[] = []): Decision {
  const telling = pr.files.filter((f) => !RIDE_ALONG.test(f.path))
  const fileAreas = (telling.length ? telling : pr.files).map((f) => areaOf(f.path))
  const areas = AREAS.filter((a) => fileAreas.includes(a))
  const lines = linesChanged(pr.files, generated)
  const { kind, sure: kindSure } = kindOf(pr, fileAreas)
  const { impact, sure: impactSure } = impactOf(pr, fileAreas)
  return {
    kind,
    kindSure,
    areas: areas.length ? areas : ['area/ci'],
    size: sizeOf(lines),
    lines,
    impact,
    impactSure,
    risks: risksOf(pr.files, fileAreas),
  }
}

/** What the required check holds a pull request to: one kind, an area, one size. */
export function missing(labels: string[]): string[] {
  const out: string[] = []
  const kindsOn = labels.filter((l) => l.startsWith('kind/'))
  if (kindsOn.length !== 1)
    out.push(kindsOn.length ? `one kind/ label, not ${kindsOn.length}` : 'a kind/ label')
  if (!labels.some((l) => l.startsWith('area/'))) out.push('an area/ label')
  if (labels.filter((l) => l.startsWith('size/')).length !== 1) out.push('one size/ label')
  return out
}
