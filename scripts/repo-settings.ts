// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The repository's settings as code, in `.github/settings/`:
 *
 *   rulesets/<name>.json   a ruleset, named as the ruleset is, holding what GitHub's API takes to
 *                          write it (name, target, enforcement, bypass actors, conditions, rules)
 *   branches/<branch>.json a branch's protection (required checks, reviews, signed commits and
 *                          the rest), as GitHub's branch protection API takes it
 *
 *   bun scripts/repo-settings.ts export   prints the live settings as those files hold them, and
 *                                          the rules that apply to main, the organization's too
 *   bun scripts/repo-settings.ts plan     says what an apply would change, and changes nothing
 *   bun scripts/repo-settings.ts apply    makes the live settings match the files: a ruleset of
 *                                          a file's name is updated, a missing one created, and a
 *                                          live one no file names deleted; a branch a file names
 *                                          is protected as the file says
 *
 * `.github/workflows/repo-settings.yml` runs it from main only, with the Cubepals app's token
 * (GH_TOKEN) and GITHUB_REPOSITORY. While a folder holds no file, apply changes nothing of its
 * kind, so nothing is deleted for want of having been written down; and a branch no file names
 * keeps the protection it has. Only the repository's own rulesets are written; the
 * organization's are shown by export and left alone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** What GitHub takes to write a ruleset; everything else it answers with is its own. */
const WRITABLE = ['name', 'target', 'enforcement', 'bypass_actors', 'conditions', 'rules'] as const

export type Ruleset = Partial<Record<(typeof WRITABLE)[number], unknown>> & { name: string }

/** A ruleset as the files keep it: the writable fields only, keys in order. */
export function kept(live: Record<string, unknown>): Ruleset {
  const out: Record<string, unknown> = {}
  for (const key of WRITABLE) if (live[key] !== undefined) out[key] = live[key]
  return sorted(out) as Ruleset
}

/** The same value with every object's keys sorted, so two settings compare by what they say. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  )
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

/** Who may do something on a protected branch, by login and slug. */
interface Actors {
  users: string[]
  teams: string[]
  apps: string[]
}

/** A branch's protection as GitHub's PUT takes it, with signed commits, which it sets apart. */
export interface Protection {
  required_status_checks: { strict: boolean; checks: { context: string; app_id: number }[] } | null
  required_pull_request_reviews: {
    dismiss_stale_reviews: boolean
    require_code_owner_reviews: boolean
    required_approving_review_count: number
    require_last_push_approval: boolean
    dismissal_restrictions?: Actors
    bypass_pull_request_allowances?: Actors
  } | null
  restrictions: Actors | null
  enforce_admins: boolean
  required_linear_history: boolean
  allow_force_pushes: boolean
  allow_deletions: boolean
  block_creations: boolean
  required_conversation_resolution: boolean
  lock_branch: boolean
  allow_fork_syncing: boolean
  required_signatures: boolean
}

/** The settings GitHub answers as `{ enabled }` and takes as a plain true or false. */
const TOGGLES = [
  'enforce_admins',
  'required_linear_history',
  'allow_force_pushes',
  'allow_deletions',
  'block_creations',
  'required_conversation_resolution',
  'lock_branch',
  'allow_fork_syncing',
  'required_signatures',
] as const

type Answer = Record<string, unknown>

/** Users, teams and apps as GitHub answers them, by login and slug, in order. */
function actors(live: unknown): Actors | undefined {
  if (!live || typeof live !== 'object') return undefined
  const {
    users = [],
    teams = [],
    apps = [],
  } = live as {
    users?: { login: string }[]
    teams?: { slug: string }[]
    apps?: { slug: string }[]
  }
  return {
    users: users.map((user) => user.login).sort(),
    teams: teams.map((team) => team.slug).sort(),
    apps: apps.map((app) => app.slug).sort(),
  }
}

/**
 * GitHub's app_id for a required check any app may set. It answers such a check with no app, and
 * takes this to keep it so: a check written with no app is tied to whichever app set it last.
 */
const ANY_APP = -1

/** The required checks, by context, each with the app that must set it. */
function checksKept(live: Answer): Exclude<Protection['required_status_checks'], null> {
  const listed =
    (live.checks as { context: string; app_id?: number | null }[] | undefined) ??
    ((live.contexts as string[] | undefined) ?? []).map((context) => ({ context }))
  return {
    strict: Boolean(live.strict),
    checks: listed
      .map(({ context, app_id }) => ({ context, app_id: app_id ?? ANY_APP }))
      .sort((a, b) => (a.context < b.context ? -1 : a.context > b.context ? 1 : 0)),
  }
}

function reviewsKept(live: Answer): Exclude<Protection['required_pull_request_reviews'], null> {
  const dismissal = actors(live.dismissal_restrictions)
  const bypass = actors(live.bypass_pull_request_allowances)
  return {
    dismiss_stale_reviews: Boolean(live.dismiss_stale_reviews),
    require_code_owner_reviews: Boolean(live.require_code_owner_reviews),
    required_approving_review_count: Number(live.required_approving_review_count ?? 0),
    require_last_push_approval: Boolean(live.require_last_push_approval),
    ...(dismissal ? { dismissal_restrictions: dismissal } : {}),
    ...(bypass ? { bypass_pull_request_allowances: bypass } : {}),
  }
}

/** A branch's protection as GitHub answers it, written as the files keep it. */
export function protectionKept(live: Answer): Protection {
  const checks = live.required_status_checks as Answer | undefined
  const reviews = live.required_pull_request_reviews as Answer | undefined
  const toggles = Object.fromEntries(
    TOGGLES.map((key) => [key, Boolean((live[key] as { enabled?: boolean } | undefined)?.enabled)]),
  )
  return sorted({
    required_status_checks: checks ? checksKept(checks) : null,
    required_pull_request_reviews: reviews ? reviewsKept(reviews) : null,
    restrictions: actors(live.restrictions) ?? null,
    ...toggles,
  }) as Protection
}

export type Step =
  | { kind: 'create'; name: string; ruleset: Ruleset }
  | { kind: 'update'; name: string; id: number; ruleset: Ruleset }
  | { kind: 'delete'; name: string; id: number }
  | { kind: 'protect'; name: string; protection: Protection; signatures: boolean }

/** What makes `live` (by id) match `wanted`; a ruleset that already says the same is left alone. */
export function plan(wanted: Ruleset[], live: { id: number; ruleset: Ruleset }[]): Step[] {
  if (wanted.length === 0) return []
  const steps: Step[] = []
  for (const ruleset of wanted) {
    const there = live.find((each) => each.ruleset.name === ruleset.name)
    if (!there) steps.push({ kind: 'create', name: ruleset.name, ruleset })
    else if (!same(ruleset, there.ruleset))
      steps.push({ kind: 'update', name: ruleset.name, id: there.id, ruleset })
  }
  for (const there of live)
    if (!wanted.some((ruleset) => ruleset.name === there.ruleset.name))
      steps.push({ kind: 'delete', name: there.ruleset.name, id: there.id })
  return steps
}

/**
 * What protects a branch as its file says: nothing when it already does, and the signed-commit
 * setting written only when it changes (GitHub keeps it apart from the rest).
 */
export function protectionPlan(branch: string, wanted: Protection, live: Protection | null): Step[] {
  if (live && same(wanted, live)) return []
  const signatures = (live?.required_signatures ?? false) !== wanted.required_signatures
  return [{ kind: 'protect', name: branch, protection: wanted, signatures }]
}

const RULESETS_DIR = '.github/settings/rulesets'
const BRANCHES_DIR = '.github/settings/branches'

/** The JSON files a folder holds, by name, in order. */
function files(dir: string): { file: string; value: Answer }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, value: JSON.parse(readFileSync(join(dir, file), 'utf8')) as Answer }))
}

/** The rulesets the files hold, each checked to be named as its file is. */
function wantedRulesets(): Ruleset[] {
  return files(RULESETS_DIR).map(({ file, value }) => {
    const ruleset = kept(value)
    if (`${ruleset.name}.json` !== file) throw new Error(`${file} holds the ruleset "${ruleset.name}"`)
    return ruleset
  })
}

/** Every key a branch's file holds: what the PUT requires, its switches and signed commits. */
const PROTECTION_KEYS = [
  'required_status_checks',
  'required_pull_request_reviews',
  'restrictions',
  ...TOGGLES,
] as const

/** A branch's file as a protection, refused by name when it lacks a key or holds one GitHub doesn't take. */
export function protectionFile(file: string, value: Answer): Protection {
  const missing = PROTECTION_KEYS.filter((key) => !(key in value))
  const unknown = Object.keys(value).filter((key) => !(PROTECTION_KEYS as readonly string[]).includes(key))
  if (missing.length || unknown.length)
    throw new Error(
      `${file} ${[missing.length && `lacks ${missing.join(', ')}`, unknown.length && `holds ${unknown.join(', ')}, which GitHub doesn't take`].filter(Boolean).join(' and ')}. \`export\` prints the whole shape.`,
    )
  return sorted(value) as Protection
}

/** The branches the files protect, each named by its file. */
function wantedProtections(): { branch: string; protection: Protection }[] {
  return files(BRANCHES_DIR).map(({ file, value }) => ({
    branch: file.replace(/\.json$/, ''),
    protection: protectionFile(file, value),
  }))
}

/** GitHub's refusal, with its status and what it said. */
class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** GitHub's answer, with what it said when it refused. */
async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN ?? ''}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
  })
  const text = await response.text()
  if (!response.ok)
    throw new Refused(
      response.status,
      `GitHub answered ${response.status} to ${init.method ?? 'GET'} ${path}: ${text}`,
    )
  return text ? JSON.parse(text) : null
}

/** The repository's own rulesets, as the files would keep them. */
async function liveRulesets(repo: string): Promise<{ id: number; ruleset: Ruleset }[]> {
  const listed = (await api(`repos/${repo}/rulesets?includes_parents=false&per_page=100`)) as {
    id: number
    source_type?: string
  }[]
  const own = listed.filter((each) => (each.source_type ?? 'Repository') === 'Repository')
  return Promise.all(
    own.map(async (each) => ({
      id: each.id,
      ruleset: kept((await api(`repos/${repo}/rulesets/${each.id}`)) as Record<string, unknown>),
    })),
  )
}

/** A branch's protection as the files would keep it, or null when it has none of this kind. */
async function liveProtection(repo: string, branch: string): Promise<Protection | null> {
  try {
    return protectionKept(
      (await api(`repos/${repo}/branches/${encodeURIComponent(branch)}/protection`)) as Answer,
    )
  } catch (error) {
    if (error instanceof Refused && error.status === 404) return null
    throw error
  }
}

/** Prints the live settings as the files would hold them. */
async function exportSettings(repo: string, live: { id: number; ruleset: Ruleset }[]): Promise<void> {
  for (const { id, ruleset } of live)
    console.log(`# rulesets/${ruleset.name}.json (id ${id})\n${JSON.stringify(ruleset, null, 2)}`)
  const branches = (await api(`repos/${repo}/branches?protected=true&per_page=100`)) as { name: string }[]
  for (const { name } of branches) {
    const protection = await liveProtection(repo, name)
    if (protection) console.log(`# branches/${name}.json\n${JSON.stringify(protection, null, 2)}`)
    else console.log(`# ${name} is protected by rulesets only`)
  }
  console.log(
    `# Rules that apply to main, the organization's included\n${JSON.stringify(await api(`repos/${repo}/rules/branches/main`), null, 2)}`,
  )
}

async function main(command: string | undefined): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const live = await liveRulesets(repo)
  if (command === 'export') return exportSettings(repo, live)
  if (command !== 'plan' && command !== 'apply')
    throw new Error('Usage: repo-settings.ts export | plan | apply')
  const steps = plan(wantedRulesets(), live)
  for (const { branch, protection } of wantedProtections())
    steps.push(...protectionPlan(branch, protection, await liveProtection(repo, branch)))
  if (steps.length === 0) console.log('The live settings already match the files.')
  for (const step of steps) {
    console.log(`${step.kind} ${step.name}`)
    if (command === 'apply') await take(repo, step)
  }
}

/** One step, written to GitHub. */
async function take(repo: string, step: Step): Promise<void> {
  if (step.kind === 'create')
    await api(`repos/${repo}/rulesets`, { method: 'POST', body: JSON.stringify(step.ruleset) })
  else if (step.kind === 'update')
    await api(`repos/${repo}/rulesets/${step.id}`, { method: 'PUT', body: JSON.stringify(step.ruleset) })
  else if (step.kind === 'delete') await api(`repos/${repo}/rulesets/${step.id}`, { method: 'DELETE' })
  else await protect(repo, step)
}

/** A branch protected as its file says, signed commits included. */
async function protect(repo: string, step: Extract<Step, { kind: 'protect' }>): Promise<void> {
  const path = `repos/${repo}/branches/${encodeURIComponent(step.name)}/protection`
  const { required_signatures, ...body } = step.protection
  await api(path, { method: 'PUT', body: JSON.stringify(body) })
  if (step.signatures)
    await api(`${path}/required_signatures`, { method: required_signatures ? 'POST' : 'DELETE' })
}

if (import.meta.main) await main(process.argv[2])
