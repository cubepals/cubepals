// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a server ticks, once a minute: as the reporter plugin samples it on a Paper server and posts
 * it to `/runtime/v1/servers/<id>/vitals` (`apps/reporter`, `Vitals.java`), or as the control plane
 * reads it over any other server's console (`tick query`); and as operators read both under
 * `/ops/v1/vitals` and `/ops/v1/servers/<id>/vitals`.
 *
 * Not for a join's own tick, which rides its `in_world` event (`join-records.ts`).
 */
import { z } from 'zod'

/** One minute's sample. Milliseconds a tick, ticks a second, and the JVM's heap in megabytes. */
export const ServerVitals = z.object({
  at: z.iso.datetime(),
  /** Ticks a second over the last minute, as Paper averages them: 20 is a server keeping up. */
  tps: z.number().min(0).max(1000),
  /** Milliseconds a tick: the average, the 95th percentile and the slowest of the last hundred. */
  mspt: z.number().min(0).max(600_000),
  msptP95: z.number().min(0).max(600_000),
  msptMax: z.number().min(0).max(600_000),
  players: z.number().int().min(0).max(100_000),
  chunks: z.number().int().min(0).max(100_000_000),
  entities: z.number().int().min(0).max(100_000_000),
  heapUsedMb: z.number().int().min(0).max(10_000_000),
  heapMaxMb: z.number().int().min(0).max(10_000_000),
  /** Milliseconds garbage collection paused the game since the sample before. */
  gcMs: z.number().int().min(0).max(10_000_000),
})
export type ServerVitals = z.infer<typeof ServerVitals>

/** What one request carries: a minute's sample, or a few the plugin couldn't send before. */
export const ServerVitalsBatch = z.object({ events: z.array(ServerVitals).max(30) })

const Moment = z.iso.datetime({ offset: true })

/** `/ops/v1/vitals`: servers by how badly they ticked, narrowed to an account's where named. */
export const VitalsQuery = z.object({
  account: z.string().min(1).max(320).optional(),
  /** At or after; an hour ago unless given. */
  since: Moment.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type VitalsQuery = z.infer<typeof VitalsQuery>

/** `/ops/v1/servers/<id>/vitals`: one server's samples since a moment, and what they add up to. */
export const ServerVitalsQuery = z.object({ since: Moment.optional() })

/**
 * Where a sample came from: the reporter plugin, which sees everything below, or the server's
 * console, which gives ticks a second, milliseconds a tick (its slowest is the 99th percentile of
 * the last hundred, which `tick query` gives) and players, and leaves the rest null.
 */
export const VITALS_SOURCES = ['reporter', 'console'] as const
export type VitalsSource = (typeof VITALS_SOURCES)[number]

/** One minute's sample as it is kept: a console's has no chunks, entities, heap or collections. */
export interface VitalsSampleView {
  at: string
  source: VitalsSource
  tps: number
  mspt: number
  msptP95: number
  msptMax: number
  players: number
  chunks: number | null
  entities: number | null
  heapUsedMb: number | null
  heapMaxMb: number | null
  gcMs: number | null
}

/** What a server's samples over a while add up to. */
export interface VitalsSummaryView {
  samples: number
  firstAt: string
  lastAt: string
  /** The lowest ticks a second any sample had, and the average. */
  tpsMin: number
  tpsMean: number
  /** Of the samples' own averages and 95th percentiles of milliseconds a tick. */
  msptP50: number
  msptP95: number
  /** The slowest single tick any sample saw. */
  msptMax: number
  /** Minutes in which the server fell behind: fewer than 18 ticks a second. */
  laggingMinutes: number
  /**
   * The most of its heap it used, as a share, and the longest garbage collection a minute held;
   * these, chunks and entities are null where only its console was read.
   */
  heapShareMax: number | null
  gcMsMax: number | null
  playersMax: number
  chunksMax: number | null
  entitiesMax: number | null
  /** Where its samples came from. */
  sources: VitalsSource[]
}

export interface ServerVitalsView {
  serverId: string
  serverName: string | null
  since: string
  /** The newest sample, or null with none since. */
  latest: VitalsSampleView | null
  summary: VitalsSummaryView | null
  /** Every sample since, oldest first. */
  samples: VitalsSampleView[]
}

/** A server among those that ticked worst: whose it is and what its samples add up to. */
export interface VitalsRowView extends VitalsSummaryView {
  serverId: string
  serverName: string
  ownerId: string
  ownerEmail: string | null
}

/**
 * The whole platform now, naming no one: the servers running, how many were sampled in the last
 * few minutes and from where, how many of those were behind in their newest sample, and how many
 * said nothing (a version before `tick query`, or a console that didn't answer).
 */
export interface PlatformVitalsView {
  at: string
  running: number
  sampled: number
  byReporter: number
  byConsole: number
  laggingNow: number
  silent: number
}

export interface VitalsListView {
  since: string
  /** The platform now; across every account, or the one named. */
  platform: PlatformVitalsView
  /** The servers that reported, the most minutes behind first, then the slowest. */
  servers: VitalsRowView[]
}

/** Below this many ticks a second a server is falling behind: Paper's own colours turn at 18. */
export const LAGGING_TPS = 18
