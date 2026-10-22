// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production's health for the people who run Cubepals: the admin Health page and the operators'
 * API (`/ops/v1/health`, `bun scripts/ops.ts health`) read the same figures. What servers are doing
 * now; how long creates, starts, wakes, rests and the rest took in the last day, week and month,
 * with a trend and splits by region and setup; what failed; where a slow operation's time went,
 * from the steps its handler reported (`server_operations.steps`); and the money at a glance. Its
 * `liveness` is `/api/health`'s answer, for whatever outside watches production. It only reads. The SQL is `health-persistence.ts`'s; what to do about a stuck operation is
 * `stuck.ts`'s.
 */
import {
  HEALTH_KINDS,
  HEALTH_WINDOWS,
  type HealthKind,
  type HealthMoneyView,
  type HealthNowView,
  type HealthOperationsInput,
  type HealthOperationView,
  type HealthView,
  type OperationStepsView,
  type ServerCountsView,
  type WindowDurationsView,
} from '@blockly/contracts'
import { DAY_MS, DAY_S, HOUR_S } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { countServers, loadControls } from '../accounts/persistence.ts'
import { type Actor, runsThePlatform } from '../actor.ts'
import { NotFound } from '../errors.ts'
import {
  type DurationRow,
  durations,
  findOperation,
  findOperations,
  type OperationRow,
  openOperations,
  runningHours,
  serverStates,
  spendSince,
  trend,
} from './health-persistence.ts'
import { KEY_SWEEPS, overdue } from './job-record.ts'
import { loadJobProgress } from './persistence.ts'

/** A split by region or setup says something once its group has this many timed. */
const SPLIT_AT_LEAST = 3

/** How far back failures and the slowest operations are listed, and how many of each. */
const LISTED_FOR_MS = 7 * DAY_MS
const FAILURES_LISTED = 25
const SLOWEST_LISTED = 10

/** Which count a server's status adds to. */
const STATE_OF: Record<string, keyof ServerCountsView> = {
  running: 'running',
  stopped: 'asleep',
  stored: 'resting',
  failed: 'failed',
}

const noServers = (): ServerCountsView => ({ running: 0, asleep: 0, resting: 0, failed: 0, busy: 0 })

/** Seconds to a tenth, which is finer than anyone reads them. */
const tenths = (value: number) => Math.round(value * 10) / 10
const maybeTenths = (value: number | null) => (value === null ? null : tenths(value))

export class PlatformHealth {
  readonly #db: Db

  constructor(deps: { db: Db }) {
    this.#db = deps.db
  }

  async view(actor: Actor, now = new Date()): Promise<HealthView> {
    allowed(actor)
    const since = new Date(now.getTime() - LISTED_FOR_MS)
    const [current, windows, failures, slowest, money] = await Promise.all([
      this.#now(),
      this.#windows(now),
      findOperations(this.#db, { since, status: 'failed', order: 'newest', limit: FAILURES_LISTED }, now),
      findOperations(
        this.#db,
        { since, status: 'succeeded', timedOnly: true, order: 'slowest', limit: SLOWEST_LISTED },
        now,
      ),
      this.#money(now),
    ])
    return {
      at: now.toISOString(),
      now: current,
      windows,
      failures: failures.map(operationView),
      slowest: slowest.map(operationView),
      money,
    }
  }

  /**
   * Whether the control plane can do its work, for anyone to ask: its database answers, and the
   * worker's key sweeps (`KEY_SWEEPS`) each succeeded within three of their intervals. One never
   * recorded counts as stale. It names only the sweeps, never what went wrong in them.
   */
  async liveness(now = new Date()): Promise<{ ok: boolean; stale: string[] }> {
    const recorded = await loadJobProgress(this.#db, KEY_SWEEPS)
    const stale = KEY_SWEEPS.filter((job) => {
      const row = recorded.find((r) => r.job === job)
      return row === undefined || overdue(row, now)
    })
    return { ok: stale.length === 0, stale }
  }

  /** Operations found by kind, since when, how slow and how they ended. */
  async operations(
    actor: Actor,
    input: HealthOperationsInput,
    now = new Date(),
  ): Promise<HealthOperationView[]> {
    allowed(actor)
    const rows = await findOperations(
      this.#db,
      {
        since: input.since === undefined ? new Date(now.getTime() - DAY_MS) : new Date(input.since),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.slowerThan === undefined ? {} : { slowerThan: input.slowerThan }),
        ...(input.status === undefined ? {} : { status: input.status }),
        order: 'newest',
        limit: input.limit,
      },
      now,
    )
    return rows.map(operationView)
  }

  /** One operation and where its time went. */
  async operation(actor: Actor, id: string, now = new Date()): Promise<OperationStepsView> {
    allowed(actor)
    const row = await findOperation(this.#db, id, now)
    if (row === null) throw new NotFound('Operation')
    return { ...operationView(row), steps: stepsOf(row, now) }
  }

  async #now(): Promise<HealthNowView> {
    const servers = noServers()
    const regions = new Map<string, ServerCountsView & { region: string }>()
    for (const { region, status, n } of await serverStates(this.#db)) {
      const state = STATE_OF[status] ?? 'busy'
      const place = regions.get(region) ?? { region, ...noServers() }
      place[state] += n
      servers[state] += n
      regions.set(region, place)
    }
    const total = (c: ServerCountsView) => c.running + c.asleep + c.resting + c.failed + c.busy
    return {
      servers,
      regions: [...regions.values()].sort((a, b) => total(b) - total(a) || a.region.localeCompare(b.region)),
      operations: await openOperations(this.#db),
    }
  }

  async #windows(now: Date): Promise<WindowDurationsView[]> {
    const [rows, hourly, daily] = await Promise.all([
      durations(this.#db, now),
      trend(this.#db, now, HOUR_S, 24),
      trend(this.#db, now, DAY_S, 30),
    ])
    return HEALTH_WINDOWS.map((window) => {
      const inWindow = rows.filter((row) => row.window === window)
      const [buckets, span] = window === '24h' ? [hourly, HOUR_S] : [daily, DAY_S]
      const length = window === '24h' ? 24 : window === '7d' ? 7 : 30
      return {
        window,
        kinds: HEALTH_KINDS.map((kind) => {
          const ofKind = inWindow.filter((row) => row.kind === kind)
          const own = ofKind.find((row) => row.region === null && row.setup === null)
          return {
            kind,
            ...stats(own),
            trend: trendOf(kind, buckets, span, length, now),
            byRegion: splits(ofKind.filter((row) => row.region !== null)).map((row) => ({
              region: row.region ?? '',
              ...stats(row),
            })),
            bySetup: splits(ofKind.filter((row) => row.setup !== null)).map((row) => ({
              setup: row.setup ?? '',
              ...stats(row),
            })),
          }
        }),
      }
    })
  }

  async #money(now: Date): Promise<HealthMoneyView> {
    const day = now.toISOString().slice(0, 10)
    const dayStart = new Date(`${day}T00:00:00Z`)
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const [today, month, spend, controls, counts] = await Promise.all([
      runningHours(this.#db, dayStart, now),
      runningHours(this.#db, monthStart, now),
      spendSince(this.#db, monthStart.toISOString().slice(0, 10)),
      loadControls(this.#db),
      countServers(this.#db),
    ])
    const ofToday = spend.find((row) => row.day === day)
    return {
      runningHoursToday: tenths(today),
      runningHoursMonth: tenths(month),
      spendTodayCents: ofToday?.cents ?? null,
      spendMonthCents: spend.reduce((sum, row) => sum + row.cents, 0),
      dailyLimitCents: controls.dailySpendLimitCents,
      trippedAt: ofToday?.trippedAt ?? null,
      running: counts.running,
      maxRunning: controls.maxRunningServers,
      servers: counts.servers,
      maxServers: controls.maxServers,
    }
  }
}

function allowed(actor: Actor): void {
  if (!runsThePlatform(actor)) throw new NotFound('Health')
}

const stats = (row: DurationRow | undefined) => ({
  count: row?.count ?? 0,
  failed: row?.failed ?? 0,
  medianSeconds: maybeTenths(row?.median ?? null),
  p90Seconds: maybeTenths(row?.p90 ?? null),
  slowestSeconds: maybeTenths(row?.slowest ?? null),
})

/** The groups with enough timed to say something, the biggest first; none when only one has. */
function splits(rows: DurationRow[]): DurationRow[] {
  const name = (row: DurationRow) => row.region ?? row.setup ?? ''
  const enough = rows
    .filter((row) => row.count >= SPLIT_AT_LEAST)
    .sort((a, b) => b.count - a.count || name(a).localeCompare(name(b)))
  return enough.length >= 2 ? enough : []
}

function trendOf(
  kind: HealthKind,
  rows: Array<{ kind: string; bucket: number; count: number; median: number }>,
  span: number,
  length: number,
  now: Date,
) {
  return Array.from({ length }, (_, i) => {
    const bucket = length - 1 - i
    const row = rows.find((r) => r.kind === kind && r.bucket === bucket)
    return {
      at: new Date(now.getTime() - (bucket + 1) * span * 1000).toISOString(),
      count: row?.count ?? 0,
      medianSeconds: maybeTenths(row?.median ?? null),
    }
  })
}

const operationView = (row: OperationRow): HealthOperationView => ({
  id: row.id,
  kind: row.kind,
  serverId: row.serverId,
  serverName: row.serverName,
  status: row.status,
  step: row.step,
  error: row.error,
  detail: row.detail,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
  seconds: tenths(row.seconds),
})

/**
 * Where an operation's time went: `queued` from being asked for to its first step, then each step
 * until the next began, the last until it finished (or now, while it runs).
 */
function stepsOf(row: OperationRow, now: Date): OperationStepsView['steps'] {
  const marks = row.steps ?? []
  const first = marks[0]
  if (first === undefined) return []
  const end = row.finishedAt === null ? now.getTime() : Date.parse(row.finishedAt)
  const span = (from: string, to: number) => tenths((to - Date.parse(from)) / 1000)
  return [
    { step: 'queued', at: row.createdAt, seconds: span(row.createdAt, Date.parse(first.at)) },
    ...marks.map((mark, i) => {
      const next = marks[i + 1]
      return { step: mark.step, at: mark.at, seconds: span(mark.at, next ? Date.parse(next.at) : end) }
    }),
  ]
}
