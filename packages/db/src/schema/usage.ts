// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When servers ran and who played on them: the power intervals play is metered by, the
 * disposable presence a sync rewrites, the play counted a day at a time, and everyone a server has
 * seen.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'
import { minecraftServers } from './servers.ts'

export const powerIntervals = pgTable(
  'power_intervals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    memoryTier: text('memory_tier').notNull(),
    /**
     * The runtime it ran on (docs/runtimes.md), from the server's binding as it started; null for
     * intervals from before deployments ran several.
     */
    provider: text('provider'),
    /**
     * The owner's plan in force as it started: a plan's hours in all count only the runs made on
     * it (Free's 20). Null for runs from before it was kept, which count toward none.
     */
    plan: text('plan'),
    startedAt: ts('started_at').notNull(),
    stoppedAt: ts('stopped_at'),
    /**
     * The last session-cap warning sent in game, as minutes left (10, then 2); null before any.
     * Kept with the interval, which is the session, so a restarted control plane doesn't repeat one.
     */
    sessionWarnedMinutes: integer('session_warned_minutes'),
    /**
     * When this session ends because the day's play runs out, fixed once its first warning is due
     * and never earlier than ten minutes after: a run is never stopped for it unwarned. Null while
     * it has more than that left, or its plan counts no day.
     */
    playEndsAt: ts('play_ends_at'),
    /**
     * Started by someone connecting rather than by a person in the app. Such a run is on
     * probation until somebody actually joins it (§15.1): a wake has to lead to play.
     */
    woken: boolean('woken').notNull().default(false),
  },
  (t) => [
    index('power_intervals_server').on(t.serverId, t.startedAt),
    uniqueIndex('power_intervals_one_open').on(t.serverId).where(sql`${t.stoppedAt} is null`),
  ],
)

// ─── Presence: derived, disposable. The migration creates both tables UNLOGGED. ─────────────

export const serverPresence = pgTable(
  'server_presence',
  {
    serverId: uuid('server_id').notNull(),
    playerUuid: uuid('player_uuid').notNull(),
    playerName: text('player_name').notNull(),
    source: text('source').notNull(),
    seenAt: ts('seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.playerUuid] })],
)

/**
 * Play on each server a day at a time, on the runtime it ran on (docs/runtimes.md), as the presence
 * sync saw it about once a minute: players online times the minutes since the last reading, and
 * the minutes anyone was online. A reading that never came is play not counted, never guessed.
 */
export const serverUsageDays = pgTable(
  'server_usage_days',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    day: date('day', { mode: 'string' }).notNull(),
    provider: text('provider').notNull(),
    playerMinutes: integer('player_minutes').notNull().default(0),
    activeMinutes: integer('active_minutes').notNull().default(0),
    peakPlayers: integer('peak_players').notNull().default(0),
    lastSampleAt: ts('last_sample_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.day, t.provider] }), index('server_usage_days_day').on(t.day)],
)

export const serverActivity = pgTable('server_activity', {
  serverId: uuid('server_id').primaryKey(),
  lastPlayerAt: ts('last_player_at').notNull(),
})

// ─── Who has played: kept, unlike presence ──────────────────────────────────────────────────

/**
 * Everyone a server has seen, written wherever presence is: what the owner is offered when naming
 * a player. A name here is as the server or the edge reported it, so it is for suggesting, never
 * for deciding who may join. It outlives stops and restarts; purging the server clears it.
 */
export const serverPlayers = pgTable(
  'server_players',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    playerUuid: uuid('player_uuid').notNull(),
    /** The name they were last seen with: names change hands, UUIDs do not. */
    playerName: text('player_name').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    /**
     * When the server itself last said they were on, not only the edge naming who connected; null
     * if it never has. Only its readings are facts enough to decide anything by.
     */
    confirmedAt: ts('confirmed_at'),
    /**
     * Their play on it that the server itself saw, in seconds: the time between two of its readings
     * that both found them on. Who a free server's main player is comes from it.
     */
    playedSeconds: integer('played_seconds').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.playerUuid] }),
    // Which other servers a server's players played on.
    index('server_players_player').on(t.playerUuid),
    // The servers someone was seen on in the last day, which free-play links read every few minutes.
    index('server_players_confirmed').on(t.confirmedAt),
  ],
)
