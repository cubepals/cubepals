// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stop cheaters as the database keeps it: each server's setting beside it (`server_stop_cheaters`,
 * no row being `auto`), the template it was made from, as its creation was audited, whether it runs,
 * by the rule in `rule.ts`, and the players it removed (`server_removals`).
 */
import type { RemovalReason } from '@blockly/contracts'
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { GRIM_FIELDS, grimFor } from '../compat/service.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import { effective, STRANGERS_TEMPLATES, type StopCheatersRow } from './rule.ts'

const rows = schema.serverStopCheaters
const removals = schema.serverRemovals
const servers = schema.minecraftServers
const audit = schema.auditLog

/** The template a server was made from, from the audit of its creation; null for none. */
const templateOf = sql<string | null>`(select ${audit.data}->>'template' from ${audit}
  where ${audit.subjectType} = 'server' and ${audit.subjectId} = ${servers.id}::text
  and ${audit.action} = 'server.created' limit 1)`

/** A server's setting, Cubepals' default where it has no row, and whether it is flagged official. */
export async function loadStopCheaters(q: Queryable, serverId: string): Promise<StopCheatersRow> {
  const [row] = await q
    .select({
      setting: rows.setting,
      reason: rows.reason,
      template: templateOf,
      takeOver: rows.takeOver,
      official: schema.publicListings.official,
    })
    .from(servers)
    .leftJoin(rows, eq(rows.serverId, servers.id))
    .leftJoin(schema.publicListings, eq(schema.publicListings.serverId, servers.id))
    .where(eq(servers.id, serverId))
  return {
    setting: row?.setting ?? 'auto',
    reason: row?.reason ?? null,
    template: row?.template ?? null,
    takeOver: row?.takeOver ?? false,
    official: row?.official ?? false,
  }
}

/** Writes some of a server's row, making it where there is none. */
export async function saveStopCheaters(
  q: Queryable,
  serverId: string,
  set: Partial<Pick<typeof rows.$inferInsert, 'setting' | 'reason' | 'takeOver'>>,
): Promise<void> {
  await q
    .insert(rows)
    .values({ serverId, ...set })
    .onConflictDoUpdate({ target: rows.serverId, set })
}

/**
 * At publish: `auto` becomes `on`, saying Browse did it. `on` and `off` stay as they are; `off` is
 * the owner's, and nothing automatic changes it.
 */
export async function onAtPublish(q: Queryable, serverId: string): Promise<void> {
  await q
    .insert(rows)
    .values({ serverId, setting: 'on', reason: 'browse' })
    .onConflictDoUpdate({
      target: rows.serverId,
      set: { setting: 'on', reason: 'browse' },
      setWhere: eq(rows.setting, 'auto'),
    })
}

/**
 * Whether any live server runs Stop cheaters at its next start: on by its setting, the template it
 * came from or the flag, and Grim placed there, so not a modded server, a pack or a release with no
 * Grim build yet.
 */
export async function anyStopCheatersOn(q: Queryable): Promise<boolean> {
  const revisions = schema.serverRevisions
  const candidates = await q
    .select({ revisionId: revisions.id })
    .from(servers)
    .innerJoin(revisions, eq(revisions.id, servers.desiredRevisionId))
    .leftJoin(rows, eq(rows.serverId, servers.id))
    .leftJoin(schema.publicListings, eq(schema.publicListings.serverId, servers.id))
    .where(
      and(
        isNull(servers.deletedAt),
        isNull(revisions.modpack),
        inArray(revisions.loader, ['paper', 'vanilla']),
        or(
          eq(rows.setting, 'on'),
          and(
            sql`coalesce(${rows.setting}, 'auto') = 'auto'`,
            or(
              eq(schema.publicListings.official, true),
              sql`${templateOf} in (${sql.join(
                STRANGERS_TEMPLATES.map((t) => sql`${t}`),
                sql`, `,
              )})`,
            ),
          ),
        ),
      ),
    )
  for (const { revisionId } of candidates)
    if ((await grimFor(q, await loadRevisionFields(q, revisionId, GRIM_FIELDS))).kind === 'placed')
      return true
  return false
}

/**
 * One removal, as the server's reporter told it; whether it is new. A reporter sends a batch again
 * when it hears no answer, so a removal already kept is kept once.
 */
export async function insertRemoval(
  q: Queryable,
  removal: { serverId: string; playerUuid: string; playerName: string; reason: RemovalReason; at: Date },
): Promise<boolean> {
  const added = await q.insert(removals).values(removal).onConflictDoNothing().returning({ id: removals.id })
  return added.length > 0
}

/** A server's newest removals, newest first. */
export const recentRemovals = (q: Queryable, serverId: string, limit: number) =>
  q.select().from(removals).where(eq(removals.serverId, serverId)).orderBy(desc(removals.at)).limit(limit)

/** One player's removals on a server, newest first. */
export const removalsOf = (q: Queryable, serverId: string, playerUuid: string) =>
  q
    .select()
    .from(removals)
    .where(and(eq(removals.serverId, serverId), eq(removals.playerUuid, playerUuid.toLowerCase())))
    .orderBy(desc(removals.at))

/** How many removals a server has had since `since`, of one reason and one player where they are given. */
export async function countRemovals(
  q: Queryable,
  serverId: string,
  since: Date | null,
  only: { playerUuid?: string; reason?: RemovalReason } = {},
): Promise<number> {
  const [row] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(removals)
    .where(
      and(
        eq(removals.serverId, serverId),
        since === null ? undefined : gte(removals.at, since),
        only.playerUuid === undefined ? undefined : eq(removals.playerUuid, only.playerUuid.toLowerCase()),
        only.reason === undefined ? undefined : eq(removals.reason, only.reason),
      ),
    )
  return row?.n ?? 0
}

/**
 * What the last start did with the punishments file, as the access sync read it from the server:
 * kept in `server_runtimes.applied` for the Players page. Once Cubepals' is in place, an owner's ask
 * to take over is done.
 */
export async function recordStartMark(
  q: Queryable,
  serverId: string,
  mark: 'ours' | 'own' | null,
): Promise<void> {
  const runtimes = schema.serverRuntimes
  await q
    .update(runtimes)
    .set({
      applied:
        mark === null
          ? sql`${runtimes.applied} - 'stopCheaters'`
          : sql`jsonb_set(${runtimes.applied}, '{stopCheaters}', ${JSON.stringify(mark)}::jsonb)`,
    })
    .where(and(eq(runtimes.serverId, serverId), isNotNull(runtimes.applied)))
  if (mark === 'ours')
    await q
      .update(rows)
      .set({ takeOver: false })
      .where(and(eq(rows.serverId, serverId), eq(rows.takeOver, true)))
}

/**
 * Whether the punishments file on a server's disk is Cubepals': its last start wrote it, or it runs
 * Stop cheaters with nothing read back yet that says the file is the owner's own.
 */
export async function cubepalsWrotePunishments(q: Queryable, serverId: string): Promise<boolean> {
  const [row] = await q
    .select({ mark: sql<string | null>`${schema.serverRuntimes.applied}->>'stopCheaters'` })
    .from(schema.serverRuntimes)
    .where(eq(schema.serverRuntimes.serverId, serverId))
  if (row?.mark === 'ours') return true
  if (row?.mark === 'own') return false
  return effective(await loadStopCheaters(q, serverId)).on
}
