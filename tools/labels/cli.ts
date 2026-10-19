// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Labels pull requests and issues on GitHub from rules.ts, with model.ts for what rules can't
 * know, and checks that a pull request carries what it must.
 *
 *   bun tools/labels/cli.ts pr <n>            label one pull request (labels.yml)
 *   bun tools/labels/cli.ts issue <n>         label one issue (labels.yml)
 *   bun tools/labels/cli.ts check <n>         the required check (labels-check.yml)
 *   bun tools/labels/cli.ts sweep             every open pull request and issue (daily)
 *   bun tools/labels/cli.ts backfill [count]  the open ones and the last <count> merged (150)
 *   bun tools/labels/cli.ts sync              make the repository's labels match rules.ts
 *
 * --dry-run prints what it would do and writes nothing. It needs GH_TOKEN and GITHUB_REPOSITORY;
 * ANTHROPIC_API_KEY is optional. It reads the change as data from the API and never checks out
 * or runs a pull request's code, so it may run with a write token on pull requests from forks.
 *
 * What a person changes stays changed: a label someone removed by hand is never put back, a kind
 * or impact someone chose is never replaced, and nothing outside rules.ts is ever added.
 */
import { readFileSync } from 'node:fs'
import type { Answer, Item } from './model.ts'
import {
  AREAS,
  type Area,
  decide,
  generatedMatchers,
  KINDS,
  type Kind,
  LABELS,
  missing,
  RENAMES,
  RETIRED,
  SIZES,
} from './rules.ts'

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const REPO = process.env.GITHUB_REPOSITORY ?? 'cubepals/cubepals'
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
const DRY = process.argv.includes('--dry-run')
/** Seconds the check waits for labels.yml; LABELS_WAIT shortens it in tests. */
const WAIT = Number(process.env.LABELS_WAIT ?? 180)
const KNOWN = new Set(LABELS.map((l) => l.name))
const say = (line: string) => process.stdout.write(`${line}\n`)
const BOTS = new Set(['github-actions[bot]', 'cubepals[bot]'])

async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // A dropped connection or a 5xx is tried again, three times at most, as the image pulls are.
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).catch((error: unknown) => {
      if (attempt >= 3) throw error
      return null
    })
    if (response?.ok) return (response.status === 204 ? null : await response.json()) as T
    if (!response || (response.status >= 500 && attempt < 3)) {
      await Bun.sleep(2000 * 2 ** attempt)
      continue
    }
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  }
}

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; ; page++) {
    const batch = await gh<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    out.push(...batch)
    if (batch.length < 100) return out
  }
}

type Issue = {
  number: number
  title: string
  body: string | null
  user: { login: string }
  labels: { name: string }[]
  pull_request?: unknown
}
type Pull = Issue & { state: string; head: { sha: string }; merged_at: string | null }

/** The model, loaded only with a key: the check and the rules alone need nothing installed. */
async function ask(item: Item): Promise<Answer | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  return (await import('./model.ts')).ask(item)
}
type File = { filename: string; additions: number; deletions: number; status: string }
type Event = { event: string; actor: { login: string } | null; label?: { name: string } }

/** Labels a person took off by hand: never put back. */
async function removedByHand(number: number): Promise<Set<string>> {
  const events = await all<Event>(`/repos/${REPO}/issues/${number}/events`)
  return new Set(
    events
      .filter((e) => e.event === 'unlabeled' && e.label && !BOTS.has(e.actor?.login ?? ''))
      .map((e) => e.label?.name as string),
  )
}

async function apply(number: number, current: string[], add: string[], remove: string[]): Promise<void> {
  const candidates = add.filter((l) => KNOWN.has(l) && !current.includes(l))
  // The timeline is read only when there is something to add: it is the costliest call here.
  const hand = candidates.length ? await removedByHand(number) : new Set<string>()
  const adding = candidates.filter((l) => !hand.has(l))
  const removing = remove.filter((l) => current.includes(l))
  say(
    `#${number}: ${adding.length ? `+${adding.join(' +')}` : 'nothing to add'}${removing.length ? ` -${removing.join(' -')}` : ''}`,
  )
  if (DRY) return
  if (adding.length) await gh('POST', `/repos/${REPO}/issues/${number}/labels`, { labels: adding })
  for (const label of removing)
    await gh('DELETE', `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(label)}`)
}

const generated = (() => {
  try {
    return generatedMatchers(readFileSync('.gitattributes', 'utf8'))
  } catch {
    return []
  }
})()

export async function labelPull(number: number): Promise<void> {
  const pr = await gh<Pull>('GET', `/repos/${REPO}/pulls/${number}`)
  const files = (await all<File>(`/repos/${REPO}/pulls/${number}/files`)).map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    status: f.status,
  }))
  const current = pr.labels.map((l) => l.name)
  const d = decide({ title: pr.title, body: pr.body ?? '', author: pr.user.login, files }, generated)
  let { kind, impact } = d
  const hasKind = current.some((l) => l.startsWith('kind/'))
  const hasImpact = current.some((l) => l.startsWith('impact/'))
  if ((!d.kindSure && !hasKind) || (!d.impactSure && !hasImpact)) {
    const answer = await ask({
      type: 'pull request',
      title: pr.title,
      body: pr.body ?? '',
      files: files.map((f) => ({ path: f.path, lines: f.additions + f.deletions })),
      areas: d.areas,
      rules: { kind, impact },
    })
    if (answer && !d.kindSure) kind = answer.kind
    if (answer && !d.impactSure) impact = answer.impact
  }
  const add = [...d.areas, d.size, ...d.risks, ...(hasKind ? [] : [kind]), ...(hasImpact ? [] : [impact])]
  // Size follows the diff: the old size goes when a push changes it.
  const remove = current.filter((l) => l.startsWith('size/') && l !== d.size)
  await apply(number, current, add, remove)
  if (pr.state === 'open') await rerunFailedCheck(pr.head.sha)
}

export async function labelIssue(number: number): Promise<void> {
  const issue = await gh<Issue>('GET', `/repos/${REPO}/issues/${number}`)
  if (issue.pull_request) return labelPull(number)
  const current = issue.labels.map((l) => l.name)
  const add: string[] = []
  const hasKind = current.some((l) => l.startsWith('kind/'))
  const hasArea = current.some((l) => l.startsWith('area/'))
  // The bug and idea forms set kind/bug or kind/feature themselves; blank issues are off.
  let areas: Area[] = []
  let kind = current.find((l) => l.startsWith('kind/'))
  if (!hasArea || !hasKind) {
    const answer = await ask({
      type: 'issue',
      title: issue.title,
      body: issue.body ?? '',
      rules: { kind: (kind as Kind | undefined) ?? 'kind/bug', impact: 'impact/players' },
    })
    if (answer) {
      areas = answer.areas
      kind ??= answer.kind
      add.push(answer.impact)
    }
  }
  if (!hasKind && kind) add.push(kind)
  if (!hasArea) add.push(...areas)
  const labelled = (hasKind || add.some((l) => l.startsWith('kind/'))) && (hasArea || areas.length > 0)
  await apply(number, current, labelled ? add : [...add, 'needs-triage'], labelled ? ['needs-triage'] : [])
}

/** The required check: one kind, an area, one size. Waits up to three minutes for labels.yml. */
export async function check(number: number): Promise<boolean> {
  for (let waited = 0; ; waited += 15) {
    const labels = (await gh<{ name: string }[]>('GET', `/repos/${REPO}/issues/${number}/labels`)).map(
      (l) => l.name,
    )
    const gaps = missing(labels)
    if (gaps.length === 0) {
      say(`#${number} has ${labels.filter((l) => /^(kind|area|size)\//.test(l)).join(', ')}.`)
      return true
    }
    if (waited >= WAIT) {
      console.error(`#${number} needs ${gaps.join(', ')}.`)
      console.error(
        `Labels are added on their own within a minute or two; if they aren't, add them by hand. Kinds: ${KINDS.join(', ')}. Areas: ${AREAS.join(', ')}. Sizes: ${SIZES.join(', ')}.`,
      )
      return false
    }
    await Bun.sleep(Math.min(15, WAIT) * 1000)
  }
}

/** Labels added with the workflow's token start no workflow, so a failed check is re-run here. */
async function rerunFailedCheck(sha: string): Promise<void> {
  const { workflow_runs: runs } = await gh<{ workflow_runs: { id: number; conclusion: string | null }[] }>(
    'GET',
    `/repos/${REPO}/actions/workflows/labels-check.yml/runs?head_sha=${sha}&event=pull_request&per_page=1`,
  )
  const latest = runs[0]
  if (latest?.conclusion !== 'failure') return
  say(`Re-running the failed label check, run ${latest.id}.`)
  if (!DRY) await gh('POST', `/repos/${REPO}/actions/runs/${latest.id}/rerun-failed-jobs`)
}

async function sweep(): Promise<void> {
  for (const pr of await all<Pull>(`/repos/${REPO}/pulls?state=open`))
    await safely(pr.number, () => labelPull(pr.number))
  for (const issue of await all<Issue>(`/repos/${REPO}/issues?state=open`))
    if (!issue.pull_request) await safely(issue.number, () => labelIssue(issue.number))
}

async function backfill(count: number): Promise<void> {
  await sweep()
  const merged: Pull[] = []
  for (let page = 1; merged.length < count; page++) {
    const batch = await gh<Pull[]>(
      'GET',
      `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
    )
    merged.push(...batch.filter((p) => p.merged_at))
    if (batch.length < 100) break
  }
  merged.sort((a, b) => (b.merged_at ?? '').localeCompare(a.merged_at ?? ''))
  // A second apart: GitHub allows 80 writes a minute, and each pull request may make two.
  for (const pr of merged.slice(0, count)) {
    await safely(pr.number, () => labelPull(pr.number))
    await Bun.sleep(1000)
  }
}

/** One item failing never stops the rest; the run still fails at the end so it is seen. */
let failures = 0
async function safely(number: number, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    failures++
    console.error(`::error::#${number}: ${error instanceof Error ? error.message : error}`)
  }
}

async function sync(): Promise<void> {
  const existing = new Map(
    (await all<{ name: string; color: string; description: string | null }>(`/repos/${REPO}/labels`)).map(
      (l) => [l.name, l],
    ),
  )
  for (const [from, to] of Object.entries(RENAMES)) {
    if (existing.has(from) && !existing.has(to)) {
      say(`rename ${from} → ${to}`)
      if (!DRY) await gh('PATCH', `/repos/${REPO}/labels/${encodeURIComponent(from)}`, { new_name: to })
      existing.set(to, existing.get(from) as never)
      existing.delete(from)
    }
  }
  for (const label of LABELS) {
    const now = existing.get(label.name)
    if (!now) {
      say(`create ${label.name}`)
      if (!DRY) await gh('POST', `/repos/${REPO}/labels`, label)
    } else if (now.color !== label.color || (now.description ?? '') !== label.description) {
      say(`update ${label.name}`)
      if (!DRY)
        await gh('PATCH', `/repos/${REPO}/labels/${encodeURIComponent(label.name)}`, {
          color: label.color,
          description: label.description,
        })
    }
  }
  for (const name of RETIRED) {
    if (!existing.has(name)) continue
    const using = await gh<unknown[]>(
      'GET',
      `/repos/${REPO}/issues?labels=${encodeURIComponent(name)}&state=all&per_page=1`,
    )
    if (using.length) say(`keep ${name}: still on #${(using[0] as Issue).number}`)
    else {
      say(`delete ${name}`)
      if (!DRY) await gh('DELETE', `/repos/${REPO}/labels/${encodeURIComponent(name)}`)
    }
  }
  const unknown = [...existing.keys()].filter(
    (n) => !KNOWN.has(n) && !(RETIRED as readonly string[]).includes(n),
  )
  if (unknown.length) say(`Not in rules.ts, left alone: ${unknown.join(', ')}`)
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2).filter((a) => a !== '--dry-run')
  const number = Number(arg)
  if (!TOKEN) {
    console.error('GH_TOKEN is required.')
    process.exit(2)
  }
  if (command === 'pr' && number) await labelPull(number)
  else if (command === 'issue' && number) await labelIssue(number)
  else if (command === 'check' && number) process.exit((await check(number)) ? 0 : 1)
  else if (command === 'sweep') await sweep()
  else if (command === 'backfill') await backfill(number || 150)
  else if (command === 'sync') await sync()
  else {
    console.error(
      'usage: cli.ts pr <n> | issue <n> | check <n> | sweep | backfill [count] | sync  [--dry-run]',
    )
    process.exit(2)
  }
  if (failures) process.exit(1)
}
