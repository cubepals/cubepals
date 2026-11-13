// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The performance mods Cubepals adds to every Fabric server as it starts: Lithium and FerriteCore
 * (`minecraft/mods.ts`), as pinned for its release beside the Via plugins
 * (`service.ts`'s `compat-pins`). They make the game cheaper to run and ask nothing of a player's
 * game. Like the Via plugins they are Cubepals' own layer, never the owner's mods: they are not in
 * the server's revision, no plan or limit counts them, and the owner's mod list doesn't show them.
 * The settings page says which run, and its switch is the way back.
 *
 * Whether a server runs them is kept beside it (`server_performance_off`), not in a revision: its
 * owner's switch turns them off (`owner`), and so does a start that failed with them and came up
 * without (`clash`, `operations/boot.ts`), so that Cubepals' own mods are never why a server
 * won't start. One the owner runs already, as their own mod, is theirs and is not added twice.
 * None on any other server type, or one playing a pack: a pack is tested as it is.
 *
 * Measured on a Fabric 26.3 server with eleven mods, a boot took the same with and without them.
 */
import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { PERFORMANCE, runsPlugin } from '../../minecraft/mods.ts'

const off = schema.serverPerformanceOff
const { compatPlugins } = schema

/** Where a Fabric server's mods go, under its directory: Cubepals' step places these there itself. */
const MODS_DIR = 'mods'

/** Why a server runs without them: its owner's switch, or a start that failed with them. */
export type PerformanceOff = 'owner' | 'clash'

/** What `performanceFor` reads of a revision. */
type Tuned = Pick<ServerRevision, 'gameVersion' | 'loader' | 'modpack'> & {
  mods: ReadonlyArray<Pick<PinnedMod, 'source' | 'name'>>
}

/** A server Cubepals' performance mods are for: Fabric, playing no pack. */
export const takesPerformance = (revision: Pick<ServerRevision, 'loader' | 'modpack'>): boolean =>
  revision.loader === 'fabric' && revision.modpack === null

/** Why the server runs without them; null where it runs them. */
export async function performanceOff(q: Queryable, serverId: string): Promise<PerformanceOff | null> {
  const [row] = await q.select({ reason: off.reason }).from(off).where(eq(off.serverId, serverId))
  return row?.reason ?? null
}

/** Turns them on, or off for `reason`. Whoever turns them off last is the reason kept. */
export async function setPerformance(
  q: Queryable,
  serverId: string,
  on: boolean,
  reason: PerformanceOff = 'owner',
): Promise<void> {
  if (on) await q.delete(off).where(eq(off.serverId, serverId))
  else
    await q
      .insert(off)
      .values({ serverId, reason })
      .onConflictDoUpdate({ target: off.serverId, set: { reason, createdAt: new Date() } })
}

/**
 * The ones a start of the server places while they are on: those pinned for its release, but any
 * its owner runs already, in `PERFORMANCE`'s order. None on a release with none pinned yet, or on a
 * server they are not for.
 */
export async function performanceIfOn(q: Queryable, revision: Tuned): Promise<PinnedMod[]> {
  if (!takesPerformance(revision)) return []
  const wanted = PERFORMANCE.filter((id) => !runsPlugin(revision.mods, id))
  if (wanted.length === 0) return []
  const rows = await q
    .select({ projectId: compatPlugins.projectId, pinned: compatPlugins.pinned })
    .from(compatPlugins)
    .where(and(eq(compatPlugins.gameVersion, revision.gameVersion), inArray(compatPlugins.projectId, wanted)))
  return wanted.flatMap((id) =>
    rows
      .filter((row) => row.projectId === id)
      .map((row) => ({ ...(row.pinned as PinnedMod), dir: MODS_DIR })),
  )
}

/**
 * The performance mods a start of the server places, in its mods folder by Cubepals' own step:
 * `performanceIfOn`'s, and none where they are off.
 */
export async function performanceFor(q: Queryable, serverId: string, revision: Tuned): Promise<PinnedMod[]> {
  const mods = await performanceIfOn(q, revision)
  return mods.length === 0 || (await performanceOff(q, serverId)) !== null ? [] : mods
}

/**
 * What a start asks of them (`operations/boot.ts`'s `OwnMods`): whether it placed any, and the way
 * to start once without them and back.
 */
export const ownModsOf = (q: Queryable) => ({
  placed: async (serverId: string, revision: Tuned) =>
    (await performanceFor(q, serverId, revision)).length > 0,
  // Never over a choice already there: an owner who turned them off in the meantime keeps theirs.
  turnOff: async (serverId: string) => {
    await q.insert(off).values({ serverId, reason: 'clash' }).onConflictDoNothing()
  },
  // Only the start's own turning off is taken back: an owner who turned them off since chose that.
  turnOn: async (serverId: string) => {
    await q.delete(off).where(and(eq(off.serverId, serverId), eq(off.reason, 'clash')))
  },
})
