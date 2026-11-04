// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production's health as the people who run Cubepals read it, on the admin Health page and through
 * the operators' API (`/ops/v1/health`): what servers are doing now, how long the work that changes
 * them takes, what failed, where a slow one spent its time, and the money at a glance. Owners never
 * see any of it.
 */
import { z } from 'zod'

/**
 * The work health reports on, by what a person waited for rather than the operation's own kind: a
 * `provision` is a create, a start a connection asked for is a wake, an `unstore` is a wake from
 * rest and a `store` is a rest. Every other operation keeps its own kind.
 */
export const HEALTH_KINDS = [
  'create',
  'start',
  'wake',
  'wake_from_rest',
  'rest',
  'restart',
  'apply',
  'restore',
] as const
export type HealthKind = (typeof HEALTH_KINDS)[number]

export const HEALTH_WINDOWS = ['24h', '7d', '30d'] as const
export type HealthWindow = (typeof HEALTH_WINDOWS)[number]

/** How many servers are in each state, somewhere or everywhere. */
export interface ServerCountsView {
  running: number
  /** Stopped, with their machine and disk kept. */
  asleep: number
  /** Stored away in the archive store, holding nothing. */
  resting: number
  failed: number
  /** Part-way through something: starting, stopping, updating, restoring, moving or resting. */
  busy: number
}

export interface HealthNowView {
  servers: ServerCountsView
  /** The same, by the region each server was made for, the busiest first. */
  regions: Array<ServerCountsView & { region: string }>
  /** Operations not finished yet, by kind; `oldestAt` is when the oldest of them was asked for. */
  operations: Array<{ kind: string; queued: number; running: number; oldestAt: string }>
}

/**
 * How long one kind of work took, from being asked for to finished, queue included: what a person
 * waited. Only work that succeeded is timed; `failed` counts what didn't. Seconds; null with none.
 */
export interface DurationStatsView {
  count: number
  failed: number
  medianSeconds: number | null
  p90Seconds: number | null
  slowestSeconds: number | null
}

export interface KindDurationsView extends DurationStatsView {
  kind: HealthKind
  /** The median in each hour (24 h) or day (7 and 30 days), oldest first; null where none finished. */
  trend: Array<{ at: string; count: number; medianSeconds: number | null }>
  /** By the region the server was made for, where at least two regions have enough to say. */
  byRegion: Array<DurationStatsView & { region: string }>
  /** By how the server was made and what it runs ("template · paper"), where there is enough. */
  bySetup: Array<DurationStatsView & { setup: string }>
}

export interface WindowDurationsView {
  window: HealthWindow
  kinds: KindDurationsView[]
}

/** One operation as health lists it. */
export interface HealthOperationView {
  id: string
  /** A `HealthKind` where it is one of those; otherwise the operation's own kind (`backup`). */
  kind: string
  serverId: string
  serverName: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  /** The last step it reached. */
  step: string | null
  /** What went wrong, in owners' words, then as it was said. */
  error: string | null
  detail: string | null
  createdAt: string
  finishedAt: string | null
  /** From being asked for to finished, or to now while it isn't. */
  seconds: number
}

/** Where an operation's time went: waiting in the queue, then each step it reported. */
export interface OperationStepsView extends HealthOperationView {
  /**
   * `queued` first, then each step as `server_operations.steps` keeps it: `attempt` where an attempt
   * began, then what the handler reported (`compute`, `booting`, `loading_world`, ...). Empty for an
   * operation from before steps were kept, where only `seconds` is known.
   */
  steps: Array<{ step: string; at: string; seconds: number }>
}

/** Running hours and spend so far, against the guards. */
export interface HealthMoneyView {
  /** Server hours run today (UTC) and this month, open runs counted to now. */
  runningHoursToday: number
  runningHoursMonth: number
  /** What the spend watchdog worked out for today, in US cents; null before it has. */
  spendTodayCents: number | null
  spendMonthCents: number
  dailyLimitCents: number
  /** When today passed the limit; null if it hasn't. */
  trippedAt: string | null
  running: number
  maxRunning: number
  servers: number
  maxServers: number
}

export interface HealthView {
  at: string
  now: HealthNowView
  windows: WindowDurationsView[]
  /** Failed operations in the last seven days, the newest first. */
  failures: HealthOperationView[]
  /** The slowest operations to succeed in the last seven days, the slowest first. */
  slowest: HealthOperationView[]
  money: HealthMoneyView
}

/** Operations found by kind, how long ago, how slow and how they ended, the newest first. */
export const HealthOperationsInput = z.object({
  kind: z.string().max(40).optional(),
  /** Finished, or asked for and not finished, at or after this. Defaults to a day ago. */
  since: z.iso.datetime({ offset: true }).optional(),
  /** Only those that took at least this long, in seconds. */
  slowerThan: z.number().min(0).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
  /** Only those on this server. */
  server: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})
export type HealthOperationsInput = z.infer<typeof HealthOperationsInput>
