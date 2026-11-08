// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The facts `domain/account/free-links.ts` scores, read, and what it decides, written: the free
 * accounts whose servers have one main player, each candidate pair's signals and score, and the
 * group and confidence of every linked account. Candidates come from one inbox, one main player
 * and players who moved (`players-moved.ts`); the other signals add to a pair's score. The tuning is the deployment's own (`../tuning.ts`).
 * What Blockly does with a group is `free-play-guard.ts`'s.
 */
import { DAY_MS } from '@blockly/contracts/durations'
import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, eq, gt, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm'
import {
  type LinkedGroup,
  levelOf,
  linkedGroups,
  linkScore,
  mainPlayer,
  NO_SIGNALS,
  sameMain,
  sharingScore,
  signedUpClose,
} from '../../domain/account/free-links.ts'
import type { LinkSignals } from '../../domain/account/tuning.ts'
import { tuning } from '../tuning.ts'
import { loadStanding } from './persistence.ts'

const play = schema.freePlay
const links = schema.freeLinks
const servers = schema.minecraftServers
const played = schema.serverPlayers

/** Two accounts and the signals found for them so far. */
export type Candidates = Map<string, { a: string; b: string; signals: Partial<LinkSignals> }>

/** Adds a pair to `found`, keeping the strongest of each signal it is found with. */
export function addCandidate(found: Candidates, a: string, b: string, signals: Partial<LinkSignals>): void {
  if (a === b) return
  const [x, y] = a < b ? [a, b] : [b, a]
  const key = `${x} ${y}`
  const was = found.get(key)?.signals ?? {}
  const merged = { ...was }
  for (const [name, value] of Object.entries(signals) as Array<[keyof LinkSignals, number]>)
    merged[name] = Math.max(was[name] ?? 0, value)
  found.set(key, { a: x, b: y, signals: merged })
}

/** Networks of sign-ups past `networkKeptMs`, forgotten. */
export async function forgetNetworks(q: Queryable, now: Date): Promise<void> {
  await q
    .update(play)
    .set({ signupNetwork: null })
    .where(
      and(
        isNotNull(play.signupNetwork),
        lt(play.createdAt, new Date(now.getTime() - tuning().freeLinks.networkKeptMs)),
      ),
    )
}

/**
 * Pairs of free accounts with one main player, from the servers the server itself saw anyone on in
 * the last day and every other server their main players played on.
 */
export async function mainPlayerPairs(q: Queryable, now: Date): Promise<Candidates> {
  const recent = await q
    .selectDistinct({ serverId: played.serverId })
    .from(played)
    .where(gt(played.confirmedAt, new Date(now.getTime() - DAY_MS)))
  const first = await mainsOf(
    q,
    recent.map((r) => r.serverId),
  )
  const uuids = [...new Set([...first.values()].map((m) => m.uuid))]
  const found: Candidates = new Map()
  if (uuids.length === 0) return found
  const elsewhere = await q
    .selectDistinct({ serverId: played.serverId })
    .from(played)
    .where(
      and(
        inArray(played.playerUuid, uuids),
        isNotNull(played.confirmedAt),
        notInArray(played.serverId, [...first.keys()]),
      ),
    )
  const mains = new Map([
    ...first,
    ...(await mainsOf(
      q,
      elsewhere.map((r) => r.serverId),
    )),
  ])
  const byPlayer = new Map<string, Array<{ ownerId: string; share: number }>>()
  for (const main of mains.values()) {
    if ((await loadStanding(q, main.ownerId, now)).plan !== 'free') continue
    byPlayer.set(main.uuid, [...(byPlayer.get(main.uuid) ?? []), main])
  }
  for (const owners of byPlayer.values())
    for (const [i, x] of owners.entries())
      for (const y of owners.slice(i + 1))
        addCandidate(found, x.ownerId, y.ownerId, { mainPlayer: sameMain(x.share, y.share) })
  return found
}

/** Each server's main player (`mainPlayer`), with its owner, for the servers that have one. */
async function mainsOf(
  q: Queryable,
  serverIds: readonly string[],
): Promise<Map<string, { ownerId: string; uuid: string; share: number }>> {
  const mains = new Map<string, { ownerId: string; uuid: string; share: number }>()
  if (serverIds.length === 0) return mains
  const rows = await q
    .select({
      serverId: played.serverId,
      ownerId: servers.ownerId,
      uuid: played.playerUuid,
      seconds: played.playedSeconds,
    })
    .from(played)
    .innerJoin(servers, eq(servers.id, played.serverId))
    .where(and(inArray(played.serverId, [...serverIds]), isNotNull(played.confirmedAt)))
  const byServer = new Map<string, { ownerId: string; seconds: Map<string, number> }>()
  for (const row of rows) {
    const server = byServer.get(row.serverId) ?? { ownerId: row.ownerId, seconds: new Map() }
    server.seconds.set(row.uuid, row.seconds)
    byServer.set(row.serverId, server)
  }
  for (const [serverId, server] of byServer) {
    const main = mainPlayer(server.seconds, tuning().freeLinks)
    if (main !== null) mains.set(serverId, { ownerId: server.ownerId, ...main })
  }
  return mains
}

/**
 * Each candidate scored with every signal (one inbox, the sign-ups' closeness and network, on top
 * of what it was found with, and what the pair had before), and kept when it scores `link` or
 * more. A pair an admin released stays released.
 */
export async function scorePairs(q: Queryable, found: Candidates): Promise<void> {
  const ids = [...new Set([...found.values()].flatMap((c) => [c.a, c.b]))]
  if (ids.length === 0) return
  const accounts = await q
    .select({
      id: schema.users.id,
      createdAt: schema.users.createdAt,
      emailKey: play.emailKey,
      network: play.signupNetwork,
    })
    .from(schema.users)
    .leftJoin(play, eq(play.userId, schema.users.id))
    .where(inArray(schema.users.id, ids))
  const byId = new Map(accounts.map((row) => [row.id, row]))
  for (const { a, b, signals } of found.values()) {
    const x = byId.get(a)
    const y = byId.get(b)
    if (x !== undefined && y !== undefined) await scorePair(q, x, y, signals)
  }
}

/** An account as a pair's score reads it. */
interface Scored {
  id: string
  createdAt: Date
  emailKey: string | null
  network: string | null
}

/** One pair scored and, at `link` or more, kept, the later sign-up first, as `free_links` keeps it. */
async function scorePair(q: Queryable, x: Scored, y: Scored, found: Partial<LinkSignals>): Promise<void> {
  const [later, earlier] = x.createdAt > y.createdAt ? [x, y] : [y, x]
  const [before] = await q
    .select()
    .from(links)
    .where(and(eq(links.accountId, later.id), eq(links.linkedId, earlier.id)))
  if (before?.releasedAt != null) return
  const now: LinkSignals = {
    ...NO_SIGNALS,
    ...found,
    inbox: x.emailKey && x.emailKey === y.emailKey ? 1 : 0,
    signedUpClose: signedUpClose(x.createdAt, y.createdAt, tuning().freeLinks),
    network: x.network && x.network === y.network ? 1 : 0,
  }
  const signals = { ...now }
  for (const name of Object.keys(now) as Array<keyof LinkSignals>)
    signals[name] = Math.max(now[name], before?.signals[name] ?? 0)
  const score = linkScore(signals, tuning().freeLinks)
  if (score < tuning().freeLinks.link) return
  await q
    .insert(links)
    .values({ accountId: later.id, linkedId: earlier.id, score, signals })
    .onConflictDoUpdate({ target: [links.accountId, links.linkedId], set: { score, signals } })
}

/** An account that now shares its group's first account's free hours, and how sure Blockly is. */
export interface NowShared {
  userId: string
  firstId: string
  confidence: number
}

/**
 * Every account's group and confidence, from every link nobody released (`linkedGroups`), written
 * on its row: the accounts that now share the first one's free hours and didn't before. One at a
 * time, so a sign-up and the job never write half each.
 */
export async function regroup(tx: Tx): Promise<NowShared[]> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('blockly:free-groups'))`)
  const pairs = (
    await tx
      .select({ a: links.accountId, b: links.linkedId, score: links.score, signals: links.signals })
      .from(links)
      .where(isNull(links.releasedAt))
  ).map(({ signals, ...pair }) => ({
    ...pair,
    sharing: sharingScore({ ...NO_SIGNALS, ...signals }, tuning().freeLinks),
  }))
  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))]
  const created =
    ids.length === 0
      ? []
      : await tx
          .select({ id: schema.users.id, createdAt: schema.users.createdAt })
          .from(schema.users)
          .where(inArray(schema.users.id, ids))
  const groups = linkedGroups(
    pairs,
    new Map(created.map((row) => [row.id, row.createdAt])),
    tuning().freeLinks,
  )
  const was = new Map(
    (
      await tx
        .select({ id: play.userId, groupId: play.groupId, confidence: play.confidence })
        .from(play)
        .where(isNotNull(play.groupId))
    ).map((row) => [row.id, row]),
  )
  const shared: NowShared[] = []
  for (const group of groups) shared.push(...(await writeGroup(tx, group, was)))
  const grouped = new Set(groups.flatMap((g) => g.members))
  const left = [...was.keys()].filter((id) => !grouped.has(id))
  if (left.length > 0)
    await tx.update(play).set({ groupId: null, confidence: null }).where(inArray(play.userId, left))
  return shared
}

/** One group written on its members' rows: those of them that share the first one's hours anew. */
async function writeGroup(
  tx: Tx,
  group: LinkedGroup,
  was: ReadonlyMap<string, { groupId: string | null; confidence: number | null }>,
): Promise<NowShared[]> {
  const [firstId] = group.members
  if (firstId === undefined) return []
  const shared: NowShared[] = []
  for (const userId of group.members) {
    const before = was.get(userId)
    // An account not keyed yet gets its row here; the next fill keeps its inbox.
    await tx
      .insert(play)
      .values({ userId, emailKey: '', groupId: firstId, confidence: group.confidence })
      .onConflictDoUpdate({ target: play.userId, set: { groupId: firstId, confidence: group.confidence } })
    const sharedBefore =
      before?.groupId === firstId && levelOf(before.confidence ?? 0, tuning().freeLinks) === 'high'
    if (userId !== firstId && group.level === 'high' && !sharedBefore)
      shared.push({ userId, firstId, confidence: group.confidence })
  }
  return shared
}
