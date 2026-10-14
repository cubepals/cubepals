// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the load test found, as numbers and words: each step's count, failures, median, p90 and
 * slowest; every distinct failure with how often and where in the code its words come from; the
 * first limit the run met, if it met one; what careless people and a shaken platform met, worst
 * first; the timeline of people, servers and players; the wakes apart; the first create's parts;
 * and the machine hours Fly's own records give, by size.
 * Written as JSON and as Markdown to the run's `--out`.
 *
 * Not for: running anything (`load-test.ts`, `load-player.ts`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { HOUR_MS, MINUTE_MS, MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { type ChaosFinding, VERDICTS } from './load-chaos.ts'
import type { StepRecord } from './load-player.ts'

/** A wait as people read it: "4.2s", "3m 10s". */
export function took(ms: number): string {
  if (ms < MINUTE_MS) return `${(ms / SECOND_MS).toFixed(1)}s`
  const s = Math.round(ms / SECOND_MS)
  return `${Math.floor(s / MINUTE_S)}m ${String(s % MINUTE_S).padStart(2, '0')}s`
}

const quantile = (sorted: readonly number[], q: number) =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0)

export interface StepStats {
  step: string
  count: number
  failed: number
  medianMs: number
  p90Ms: number
  slowestMs: number
  /** Joins the edge turned away before one got in, over the step's runs. */
  retries: number
}

/** Each step's numbers, in the order steps first happened; times are of the ones that worked. */
export function stepStats(records: readonly StepRecord[]): StepStats[] {
  const steps = [...new Set(records.map((r) => r.step))]
  return steps.map((step) => {
    const of = records.filter((r) => r.step === step)
    const times = of
      .filter((r) => r.ok)
      .map((r) => r.ms)
      .sort((a, b) => a - b)
    return {
      step,
      count: of.length,
      failed: of.filter((r) => !r.ok).length,
      medianMs: quantile(times, 0.5),
      p90Ms: quantile(times, 0.9),
      slowestMs: times.at(-1) ?? 0,
      retries: of.reduce((sum, r) => sum + (r.retries ?? 0), 0),
    }
  })
}

/** What a failure says, with what changes from one to the next (ids, numbers, names) taken out. */
const shapeOf = (error: string) =>
  error
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{14,}\b/g, '<id>')
    .replace(/load-\w+-\d+@\S+/g, '<email>')
    .replace(/Load\d+F?\b/g, '<player>')
    .replace(/\d+(\.\d+)?/g, 'N')

export interface Failure {
  shape: string
  count: number
  steps: string[]
  example: string
  operation?: string
  /** Where the product's words in it are written, as `git grep` finds them. */
  where: string[]
}

/** The longest run of plain words in a message, which is what the code writes out. */
function phraseOf(error: string): string | null {
  const parts = error
    .split(/["'`:;()[\]{}<>|]|\b\d+\S*/)
    .map((p) => p.trim())
    .filter((p) => p.split(' ').length >= 3)
    .sort((a, b) => b.length - a.length)
  return parts[0]?.slice(0, 60) ?? null
}

function whereSaid(error: string): string[] {
  const phrase = phraseOf(error)
  if (phrase === null) return []
  const found = Bun.spawnSync(['git', 'grep', '-n', '-F', phrase, '--', 'apps', 'packages', 'scripts/lib'])
  return new TextDecoder()
    .decode(found.stdout)
    .split('\n')
    .filter((line) => line !== '' && !line.includes('.test.ts'))
    .map((line) => line.split(':').slice(0, 2).join(':'))
    .slice(0, 3)
}

/** Every distinct failure, the most frequent first. */
export function failuresOf(records: readonly StepRecord[]): Failure[] {
  const byShape = new Map<string, StepRecord[]>()
  for (const r of records.filter((r) => !r.ok)) {
    const shape = shapeOf(`${r.error ?? ''}${r.operation ? ` | ${r.operation}` : ''}`)
    byShape.set(shape, [...(byShape.get(shape) ?? []), r])
  }
  return [...byShape.entries()]
    .map(([shape, of]) => {
      const first = of[0] as StepRecord
      return {
        shape,
        count: of.length,
        steps: [...new Set(of.map((r) => r.step))],
        example: first.error ?? '',
        ...(first.operation ? { operation: first.operation } : {}),
        where: whereSaid(`${first.operation ?? ''} ${first.error ?? ''}`),
      }
    })
    .sort((a, b) => b.count - a.count)
}

/**
 * Limits a run can meet, each known by the words its refusal or error uses. The first failure
 * that names one is the first limit met.
 */
const LIMITS: Array<[string, RegExp]> = [
  [
    'servers on the platform (its max servers, or the ceiling Fly’s machine limit sets)',
    /is full right now|hosting provider's own limit|machine limit/i,
  ],
  ['running servers on the platform (its max running servers)', /is busy right now/i],
  ['the platform paused (an admin, or the daily spend watchdog)', /is paused for a moment/i],
  ['Fly capacity in the region', /no room|capacity|insufficient (memory|resources)/i],
  ['Fly volumes or IPs', /volume|ip address|allocate/i],
  ['database connections', /too many (clients|connections)|connection (pool|slots)|remaining connection/i],
  ['rate limits', /\b429\b|rate limit|too many requests|slow down|try again in/i],
  ['the mail catcher', /no email with/i],
  ['the edge', /edge (said|closed)|ECONNREFUSED|ETIMEDOUT|ECONNRESET|Connection throttled/i],
  ['memory', /out of memory|oom/i],
]

export function firstLimit(records: readonly StepRecord[]): { limit: string; record: StepRecord } | null {
  for (const record of [...records].filter((r) => !r.ok).sort((a, b) => a.at + a.ms - (b.at + b.ms))) {
    const said = `${record.error ?? ''} ${record.operation ?? ''}`
    const hit = LIMITS.find(([, words]) => words.test(said))
    if (hit) return { limit: hit[0], record }
  }
  return null
}

/** One Fly machine's time running, as its own events record it. */
export interface MachineRun {
  app: string
  machine: string
  size: string
  runningMs: number
}

interface FlyEvent {
  status: string
  timestamp: number
}

/** The time a machine was running, from Fly's own events: from each start to the stop, suspend or exit after. */
export function runningMs(events: readonly FlyEvent[], now = Date.now()): number {
  let total = 0
  let since: number | null = null
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (event.status === 'started' && since === null) since = event.timestamp
    else if (['stopped', 'suspended', 'destroyed', 'destroying'].includes(event.status) && since !== null) {
      total += event.timestamp - since
      since = null
    }
  }
  return since === null ? total : total + now - since
}

/** Machine hours by size, over every machine the run made. */
export function hoursBySize(
  runs: readonly MachineRun[],
): Array<{ size: string; machines: number; hours: number }> {
  const by = new Map<string, { machines: number; ms: number }>()
  for (const run of runs) {
    const seen = by.get(run.size) ?? { machines: 0, ms: 0 }
    by.set(run.size, { machines: seen.machines + 1, ms: seen.ms + run.runningMs })
  }
  return [...by.entries()].map(([size, { machines, ms }]) => ({ size, machines, hours: ms / HOUR_MS }))
}

/** The run at one moment, as the live line read it. */
export interface Moment {
  /** Ms since the run began. */
  t: number
  /** People arrived and not done with their lives. */
  active: number
  making: number
  playing: number
  /** Servers the platform's health counted running, asleep and busy, all of staging. */
  running: number
  asleep: number
  busy: number
  /** Headless players in a world now, as the probes count them. */
  inWorld: number
  queued: number
}

/** A part of a wait, timed over many: what the first create's time went on, say. */
export interface PartStats {
  part: string
  count: number
  medianMs: number
  p90Ms: number
  slowestMs: number
}

/** Each part's numbers, in the order parts first appear. */
export function partStats(parts: ReadonlyArray<{ part: string; ms: number }>): PartStats[] {
  return [...new Set(parts.map((p) => p.part))].map((part) => {
    const times = parts
      .filter((p) => p.part === part)
      .map((p) => p.ms)
      .sort((a, b) => a - b)
    return {
      part,
      count: times.length,
      medianMs: quantile(times, 0.5),
      p90Ms: quantile(times, 0.9),
      slowestMs: times.at(-1) ?? 0,
    }
  })
}

/** The chaos findings, worst for the person first. */
export const worstFirst = (findings: readonly ChaosFinding[]): ChaosFinding[] =>
  [...findings].sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || a.at - b.at)

export interface Report {
  run: string
  arrivals: number
  overMinutes: number
  plan: string
  startedAt: string
  tookMs: number
  steps: StepStats[]
  failures: Failure[]
  chaos: ChaosFinding[]
  firstLimit: { limit: string; step: string; error: string } | null
  timeline: Moment[]
  /** The first server's create, from the click to running, by the parts its operation records. */
  createParts: PartStats[]
  machineHours: Array<{ size: string; machines: number; hours: number }>
  /** The most the platform's own health counted at once while the run ran. */
  peak: Record<string, number>
  /** The control plane's own retries of the run's operations, from their records. */
  operationRetries: Array<{ kind: string; operations: number; retried: number; failed: number }>
  records: StepRecord[]
}

const stepRow = (s: StepStats) =>
  `| ${s.step} | ${s.count} | ${s.failed} | ${took(s.medianMs)} | ${took(s.p90Ms)} | ${took(s.slowestMs)} | ${s.retries} |`
const STEP_HEAD = [
  '| Step | Runs | Failed | Median | p90 | Slowest | Join retries |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
]
const isWake = (step: string) => /^(wakes when a player joins|starts from the website) \(/.test(step)

/** The timeline, a row a minute: the last moment read in each. */
function timelineRows(timeline: readonly Moment[]): string[] {
  const byMinute = new Map<number, Moment>()
  for (const moment of timeline) byMinute.set(Math.floor(moment.t / MINUTE_MS), moment)
  return [
    '| Minute | People active | Making | Playing | Running | Asleep | Busy | Players in a world | Queued |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...[...byMinute.entries()].map(
      ([minute, m]) =>
        `| ${minute} | ${m.active} | ${m.making} | ${m.playing} | ${m.running} | ${m.asleep} | ${m.busy} | ${m.inWorld} | ${m.queued} |`,
    ),
  ]
}

/** The most servers running at once, as the platform's health counted them, and when the run first got there. */
function peakLine(timeline: readonly Moment[]): string {
  const most = Math.max(0, ...timeline.map((m) => m.running))
  const first = timeline.find((m) => m.running === most)
  return first === undefined
    ? 'No servers running were counted.'
    : `At the peak ${most} servers were running, first reached ${took(first.t)} after the start, with ${first.inWorld} players in a world.`
}

/** The report as Markdown, for the PR and for people: what went wrong first. */
export function markdown(report: Report): string {
  const lines = [
    `# Load test ${report.run}: ${report.arrivals} people over ${report.overMinutes} min, plan ${report.plan}`,
    '',
    `Started ${report.startedAt}, took ${took(report.tookMs)}.`,
    '',
    peakLine(report.timeline),
    '',
    '## Failures',
    '',
    ...(report.failures.length === 0
      ? ['None.']
      : report.failures.flatMap((f) => [
          `- **${f.count}×** in ${f.steps.join(', ')}: ${f.example}`,
          ...(f.operation ? [`  - operation: ${f.operation}`] : []),
          ...(f.where.length > 0 ? [`  - said at: ${f.where.join(', ')}`] : []),
        ])),
    '',
    '## Chaos: what careless people and a shaken platform met, worst first',
    '',
    ...(report.chaos.length === 0
      ? ['None.']
      : [
          '| Verdict | Act | Person | What the product did |',
          '| --- | --- | ---: | --- |',
          ...worstFirst(report.chaos).map(
            (c) => `| ${c.verdict} | ${c.act} | ${c.player ?? '-'} | ${c.did.replaceAll('|', '/')} |`,
          ),
        ]),
    '',
    '## First limit met',
    '',
    report.firstLimit === null
      ? 'None.'
      : `${report.firstLimit.limit}, in "${report.firstLimit.step}": ${report.firstLimit.error}`,
    '',
    '## Steps',
    '',
    ...STEP_HEAD,
    ...report.steps.filter((s) => !isWake(s.step)).map(stepRow),
    '',
    '## Wakes: resumed from suspend against a full boot',
    '',
    ...STEP_HEAD,
    ...report.steps.filter((s) => isWake(s.step)).map(stepRow),
    '',
    '## The first create, part by part',
    '',
    '| Part | Count | Median | p90 | Slowest |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.createParts.map(
      (p) => `| ${p.part} | ${p.count} | ${took(p.medianMs)} | ${took(p.p90Ms)} | ${took(p.slowestMs)} |`,
    ),
    '',
    '## Timeline',
    '',
    ...timelineRows(report.timeline),
    '',
    '## Most at once, as the platform’s health counted',
    '',
    ...Object.entries(report.peak).map(([what, n]) => `- ${what}: ${n}`),
    '',
    '## The control plane’s own retries',
    '',
    '| Operation | Count | Retried | Failed |',
    '| --- | ---: | ---: | ---: |',
    ...report.operationRetries.map((o) => `| ${o.kind} | ${o.operations} | ${o.retried} | ${o.failed} |`),
    '',
    '## Fly machine hours, from its own events',
    '',
    '| Size | Machines | Hours |',
    '| --- | ---: | ---: |',
    ...report.machineHours.map((m) => `| ${m.size} | ${m.machines} | ${m.hours.toFixed(2)} |`),
    '',
  ]
  return lines.join('\n')
}

/** The report as `<out>.json` and `<out>.md`. */
export function write(out: string, report: Report): void {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(`${out}.json`, JSON.stringify(report, null, 2))
  writeFileSync(`${out}.md`, markdown(report))
}
