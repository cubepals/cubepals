// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The repository's rulesets as code: one file per ruleset in `.github/settings/rulesets/`, named
 * as the ruleset is, holding what GitHub's API takes to write it (name, target, enforcement,
 * bypass actors, conditions, rules).
 *
 *   bun scripts/repo-settings.ts export   prints the live rulesets as those files hold them, and
 *                                          the rules that apply to main, the organization's too
 *   bun scripts/repo-settings.ts plan     says what an apply would change, and changes nothing
 *   bun scripts/repo-settings.ts apply    makes the live rulesets match the files: a ruleset of
 *                                          a file's name is updated, a missing one created, and a
 *                                          live one no file names deleted
 *
 * `.github/workflows/repo-settings.yml` runs it from main only, with the Cubepals app's token
 * (GH_TOKEN) and GITHUB_REPOSITORY. While the folder holds no file, apply changes nothing, so the
 * rulesets are never deleted for want of having been written down. Only the repository's own
 * rulesets are written; the organization's are shown by export and left alone.
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

/** The same value with every object's keys sorted, so two rulesets compare by what they say. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  )
}

export type Step =
  | { kind: 'create'; name: string; ruleset: Ruleset }
  | { kind: 'update'; name: string; id: number; ruleset: Ruleset }
  | { kind: 'delete'; name: string; id: number }

/** What makes `live` (by id) match `wanted`; a ruleset that already says the same is left alone. */
export function plan(wanted: Ruleset[], live: { id: number; ruleset: Ruleset }[]): Step[] {
  if (wanted.length === 0) return []
  const steps: Step[] = []
  for (const ruleset of wanted) {
    const there = live.find((each) => each.ruleset.name === ruleset.name)
    if (!there) steps.push({ kind: 'create', name: ruleset.name, ruleset })
    else if (JSON.stringify(sorted(ruleset)) !== JSON.stringify(sorted(there.ruleset)))
      steps.push({ kind: 'update', name: ruleset.name, id: there.id, ruleset })
  }
  for (const there of live)
    if (!wanted.some((ruleset) => ruleset.name === there.ruleset.name))
      steps.push({ kind: 'delete', name: there.ruleset.name, id: there.id })
  return steps
}

const RULESETS_DIR = '.github/settings/rulesets'

/** The rulesets the files hold, each checked to be named as its file is. */
function wantedRulesets(dir = RULESETS_DIR): Ruleset[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const ruleset = kept(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>)
      if (`${ruleset.name}.json` !== file) throw new Error(`${file} holds the ruleset "${ruleset.name}"`)
      return ruleset
    })
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
    throw new Error(`GitHub answered ${response.status} to ${init.method ?? 'GET'} ${path}: ${text}`)
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

async function main(command: string | undefined): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const live = await liveRulesets(repo)
  if (command === 'export') {
    for (const { id, ruleset } of live)
      console.log(`# ${ruleset.name}.json (id ${id})\n${JSON.stringify(ruleset, null, 2)}`)
    console.log(
      `# Rules that apply to main, the organization's included\n${JSON.stringify(await api(`repos/${repo}/rules/branches/main`), null, 2)}`,
    )
    return
  }
  if (command !== 'plan' && command !== 'apply')
    throw new Error('Usage: repo-settings.ts export | plan | apply')
  const wanted = wantedRulesets()
  if (wanted.length === 0) {
    console.log(`${RULESETS_DIR} holds no ruleset yet, so nothing is changed.`)
    return
  }
  const steps = plan(wanted, live)
  if (steps.length === 0) console.log('The live rulesets already match the files.')
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
  else await api(`repos/${repo}/rulesets/${step.id}`, { method: 'DELETE' })
}

if (import.meta.main) await main(process.argv[2])
