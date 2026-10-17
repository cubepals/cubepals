// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The time zone an account's day and month are counted in, as its owner's browser reports it. A
 * zone reported before the account has played anything is used at once; after that, it waits until
 * the month has begun again in both zones (`zoneTakesOver`), so a month is counted in one zone from
 * its start to its end and a change never opens its hours early. The standing sweep makes the
 * change when its moment comes (`applyTimeZones`), and the account page says when that is. The
 * clock itself is `domain/account/play-day.ts`'s.
 */
import { type Db, schema, type Tx } from '@blockly/db'
import { and, eq, lte } from 'drizzle-orm'
import { DEFAULT_TIME_ZONE, monthStart, zoneTakesOver } from '../../domain/account/play-day.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import { saveStanding } from './persistence.ts'

/** Keeps `zone`, reported by the owner's browser at `now`, against the account's `locked` standing. */
export async function reportTimeZone(
  tx: Tx,
  locked: AccountStanding,
  zone: string,
  now: Date,
): Promise<void> {
  if (zone === (locked.nextTimeZone ?? locked.timeZone)) return
  // Back where the month is already counted: nothing waits any more.
  if (zone === locked.timeZone)
    return await saveStanding(tx, locked.userId, { nextTimeZone: null, nextTimeZoneFrom: null })
  if (!(await hasPlayed(tx, locked.userId)))
    return await saveStanding(tx, locked.userId, {
      timeZone: zone,
      timeZoneFrom: null,
      timeZoneBegan: null,
      nextTimeZone: null,
      nextTimeZoneFrom: null,
    })
  await saveStanding(tx, locked.userId, {
    nextTimeZone: zone,
    nextTimeZoneFrom: zoneTakesOver(now, locked.timeZone ?? DEFAULT_TIME_ZONE, zone),
  })
}

/** Whether any of the account's servers ever ran: until then, no month or day has counted anything. */
async function hasPlayed(tx: Tx, userId: string): Promise<boolean> {
  const [run] = await tx
    .select({ id: schema.powerIntervals.id })
    .from(schema.powerIntervals)
    .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, schema.powerIntervals.serverId))
    .where(eq(schema.minecraftServers.ownerId, userId))
    .limit(1)
  return run !== undefined
}

/**
 * `standing-sweep`: each zone that waited and whose moment has come takes over, recorded with when
 * the month it takes over in began in the zone before, and in the account's log. A report that changed
 * what waits in the meantime is left for the next pass. How many changed.
 */
export async function applyTimeZones(db: Db, now: Date): Promise<number> {
  const standing = schema.accountStanding
  const due = await db
    .select({
      userId: standing.userId,
      timeZone: standing.timeZone,
      next: standing.nextTimeZone,
      from: standing.nextTimeZoneFrom,
    })
    .from(standing)
    .where(lte(standing.nextTimeZoneFrom, now))
  let changed = 0
  for (const row of due) {
    if (row.next === null || row.from === null) continue
    const { next, from } = row
    const was = row.timeZone ?? DEFAULT_TIME_ZONE
    const moved = await db.transaction(async (tx) => {
      const rows = await tx
        .update(standing)
        .set({
          timeZone: next,
          timeZoneFrom: from,
          timeZoneBegan: monthStart(from, was),
          nextTimeZone: null,
          nextTimeZoneFrom: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(standing.userId, row.userId),
            eq(standing.nextTimeZone, next),
            eq(standing.nextTimeZoneFrom, from),
          ),
        )
        .returning({ userId: standing.userId })
      if (rows.length === 0) return false
      await tx.insert(schema.auditLog).values({
        actor: 'system:time_zone',
        action: 'account.time_zone_changed',
        subjectType: 'account',
        subjectId: row.userId,
        data: { from: was, to: next, at: from.toISOString() },
      })
      return true
    })
    if (moved) changed++
  }
  return changed
}
