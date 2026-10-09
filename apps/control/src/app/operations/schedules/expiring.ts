/**
 * Sends to the trash, as its owner deleting it would, a server whose time is up: one made for a
 * while once its end comes, and a world unplayed for longer than its plan keeps one, never without
 * its owner warned twice first. What happens in the trash is `servers/service.ts`'s and the purge
 * sweep's (`purge-sweep.ts`); resting a world nobody plays is `store-sweep.ts`'s.
 */
import { type Db, schema } from '@blockly/db'
import { and, isNull, lte } from 'drizzle-orm'
import { entitlementsFor, PLAN_KEYS } from '../../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { emailOf, loadControls, loadStanding } from '../../accounts/persistence.ts'
import type { Actor } from '../../actor.ts'
import type { Mailer } from '../../ports/platform.ts'
import { deletionWarned, findServer, saveDeletionWarned, unplayedSince } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Days before a world goes for being unplayed that its owner is told, first and last. */
const WARN_DAYS = [30, 7] as const

/** A warning sent for the world's current stretch of idleness, or null; see `deletion_warned`. */
function warningOf(recorded: string | null, lastActiveAt: Date): { days: number; at: Date } | null {
  const [since, days, at] = (recorded ?? '').split('|')
  if (since !== lastActiveAt.toISOString() || days === undefined || at === undefined) return null
  return { days: Number(days), at: new Date(at) }
}

const EXPIRED: Actor = { kind: 'system', reason: 'expired' }

export function expiring(deps: {
  db: Db
  mailer: Mailer
  /** Where people reach the web app, for the links in a warning. */
  webOrigin: string
  service: Pick<MinecraftServerService, 'deleteServer'>
}) {
  const { db, mailer, webOrigin, service } = deps

  /**
   * `retention-sweep`: a world its plan keeps only so long after it was last played
   * is deleted when that runs out — into the trash, as its owner deleting it would — and never
   * without two warnings first, 30 and 7 days before, each with a way to keep it and a way to
   * download it. A deletion never comes sooner than 7 days after the last warning went, whatever
   * the dates say, so a sweep that was off, or an email that couldn't go, only ever makes it later.
   * Nothing happens until an admin turns it on.
   */
  const retentionSweep = async (now: Date, limit: number): Promise<{ warned: number; deleted: number }> => {
    const done = { warned: 0, deleted: 0 }
    if (!(await loadControls(db)).expiringEnabled) return done
    const kept = PLAN_KEYS.map((plan) => entitlementsFor(plan).deleteAfterIdleDays).filter(
      (days): days is number => days !== null,
    )
    if (kept.length === 0) return done
    const firstWarning = new Date(now.getTime() - (Math.min(...kept) - WARN_DAYS[0]) * DAY_MS)
    for (const server of await unplayedSince(db, firstWarning, limit)) {
      const standing = await loadStanding(db, server.ownerId)
      const days = entitlementsFor(standing.plan, standing.limitOverrides).deleteAfterIdleDays
      if (days === null) continue
      const due = server.lastActiveAt.getTime() + days * DAY_MS
      const warned = warningOf(await deletionWarned(db, server.id), server.lastActiveAt)
      const last = WARN_DAYS[WARN_DAYS.length - 1] ?? 7
      if (warned?.days === last && now.getTime() >= Math.max(due, warned.at.getTime() + last * DAY_MS)) {
        await service.deleteServer(EXPIRED, server.id, server.name)
        done.deleted++
        continue
      }
      const mark = [...WARN_DAYS].reverse().find((before) => due - now.getTime() <= before * DAY_MS)
      if (mark === undefined || (warned !== null && warned.days <= mark)) continue
      // The date it goes is never sooner than the notice this warning gives.
      const goes = new Date(Math.max(due, now.getTime() + mark * DAY_MS))
      if (!(await warnUnplayed(server, goes))) continue
      await saveDeletionWarned(
        db,
        server.id,
        `${server.lastActiveAt.toISOString()}|${mark}|${now.toISOString()}`,
      )
      done.warned++
    }
    return done
  }

  /** The email before a world goes: when, why, and the two ways to keep it. False if it couldn't go. */
  const warnUnplayed = async (server: MinecraftServer, goes: Date): Promise<boolean> => {
    const to = await emailOf(db, server.ownerId)
    if (to === null) return false
    const day = (at: Date) =>
      at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    const page = `${webOrigin}/servers/${server.id}`
    return mailer
      .send({
        to,
        subject: `We’re keeping ${server.name} until ${day(goes)}`,
        text: [
          `Nobody has played ${server.name} since ${day(server.lastActiveAt)}. Free worlds are kept for a year after they were last played, so on ${day(goes)} it will be deleted.`,
          '',
          `To keep it, play on it, or press Keep it on its page: ${page}`,
          `You can download it there too: ${page}/backups`,
        ].join('\n'),
      })
      .then(
        () => true,
        () => false,
      )
  }

  /**
   * Servers made for a while, once their time is up. Deleting one is exactly what its owner
   * deleting it would be — it goes to the trash, where its world keeps the plan's retention and
   * can be restored — so nothing here is a special kind of deletion.
   */
  const expirySweep = async (now: Date): Promise<number> => {
    const due = await db
      .select({ id: schema.minecraftServers.id })
      .from(schema.minecraftServers)
      .where(and(isNull(schema.minecraftServers.deletedAt), lte(schema.minecraftServers.expiresAt, now)))
    let deleted = 0
    for (const { id } of due) {
      const server = await findServer(db, id)
      if (server === null || server.expiresAt === null || server.expiresAt > now) continue
      await service.deleteServer(EXPIRED, id, server.name)
      deleted += 1
    }
    return deleted
  }

  return { retentionSweep, expirySweep }
}
