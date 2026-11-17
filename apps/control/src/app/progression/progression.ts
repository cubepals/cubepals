// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline world progression: what Cubepals places on a server so its world keeps going while nobody
 * is near it, in another dimension, or while the server is stopped or asleep: furnaces and brewing,
 * crops and plants, animals growing up, world changes, and, where its owner turns it on, fire
 * (apps/progression, docs/offline-progression.md). Which parts run is kept beside the server
 * (`server_progression_parts`) and given to each start as `CUBEPALS_PROGRESSION`. On Paper, and plain Minecraft run on Paper, it is a plugin;
 * on Fabric for Minecraft 26.3, a mod. Both are jars Cubepals builds (`artifacts/progression-jar.ts`)
 * and, like the performance mods, its own layer: never in the server's revision, its mods or what a
 * plan counts.
 *
 * It is on for every server it is for, existing ones too, until its owner turns it off: whether a
 * server runs it is kept beside it (`server_progression_off`), as the performance mods' is. A start
 * that failed with the Fabric mod turns it off (`clash`), so Cubepals' own mod is never why a
 * server keeps failing to start (`operations/boot.ts`, `ownModsOf`).
 *
 * None on any other server: a modpack (tested as it is), Forge, NeoForge, Quilt, Fabric on another
 * release (the mod reaches into the game's own code, which moves between releases), or plain
 * Minecraft on Mojang's own server, which takes no plugins.
 */
import { PROGRESSION_DEFAULTS, PROGRESSION_PARTS, type ProgressionPart } from '@blockly/contracts'
import { type Queryable, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { runsOnPaper, type ServerRevision } from '../../domain/revision/revision.ts'
import { PROGRESSION_MOD, PROGRESSION_PLUGIN } from '../artifacts/progression-jar.ts'

const off = schema.serverProgressionOff
const kept = schema.serverProgressionParts

/**
 * The variable a start gives the plugin or mod: the parts that are on, by name, comma-separated
 * (`apps/progression`'s `Part.ENV`). Only a start reads it, so a change reaches a server at its
 * next start.
 */
export const PROGRESSION_ENV = 'CUBEPALS_PROGRESSION'

/** The Minecraft release the Fabric mod is built for, as its `fabric.mod.json` says (`~26.3`). */
export const FABRIC_RELEASE = '26.3'

/** Why a server runs without it: its owner's switch, or a start that failed with it. */
export type ProgressionOff = 'owner' | 'clash'

/** What `progressionKind` reads of a revision. */
export type Progressed = Pick<ServerRevision, 'gameVersion' | 'loader' | 'loaderVersion' | 'modpack'> & {
  mods: ReadonlyArray<Pick<PinnedMod, 'loaders'>>
}

/** Which of the two a server takes: the plugin, the mod, or neither. */
export function progressionKind(revision: Progressed): 'plugin' | 'mod' | null {
  if (revision.modpack !== null) return null
  if (revision.loader === 'paper' || (revision.loader === 'vanilla' && runsOnPaper(revision))) return 'plugin'
  const release =
    revision.gameVersion === FABRIC_RELEASE || revision.gameVersion.startsWith(`${FABRIC_RELEASE}.`)
  return revision.loader === 'fabric' && release ? 'mod' : null
}

/** Why the server runs without it; null where it runs it. */
export async function progressionOff(q: Queryable, serverId: string): Promise<ProgressionOff | null> {
  const [row] = await q.select({ reason: off.reason }).from(off).where(eq(off.serverId, serverId))
  return row?.reason ?? null
}

/** Turns it on, or off for `reason`. Whoever turns it off last is the reason kept. */
export async function setProgression(
  q: Queryable,
  serverId: string,
  on: boolean,
  reason: ProgressionOff = 'owner',
): Promise<void> {
  if (on) await q.delete(off).where(eq(off.serverId, serverId))
  else
    await q
      .insert(off)
      .values({ serverId, reason })
      .onConflictDoUpdate({ target: off.serverId, set: { reason, createdAt: new Date() } })
}

/** Which parts the server runs: its owner's choices, Cubepals' default where they made none. */
export async function progressionParts(
  q: Queryable,
  serverId: string,
): Promise<Record<ProgressionPart, boolean>> {
  const [row] = await q.select().from(kept).where(eq(kept.serverId, serverId))
  if (row === undefined) return { ...PROGRESSION_DEFAULTS }
  return Object.fromEntries(PROGRESSION_PARTS.map((part) => [part, row[part]])) as Record<
    ProgressionPart,
    boolean
  >
}

/** Turns one part on or off, keeping the others as they are. */
export async function setProgressionPart(
  q: Queryable,
  serverId: string,
  part: ProgressionPart,
  on: boolean,
): Promise<void> {
  await q
    .insert(kept)
    .values({ serverId, ...PROGRESSION_DEFAULTS, [part]: on })
    .onConflictDoUpdate({ target: kept.serverId, set: { [part]: on, updatedAt: new Date() } })
}

/** The variable for a start, from the parts that are on, in their order. */
export const progressionEnv = (parts: Record<ProgressionPart, boolean>): Record<string, string> => ({
  [PROGRESSION_ENV]: PROGRESSION_PARTS.filter((part) => parts[part]).join(','),
})

/** The jar a start of the server places while it is on; none on a server it isn't for, or before it is stored. */
async function progressionIfOn(q: Queryable, revision: Progressed): Promise<PinnedMod[]> {
  const kind = progressionKind(revision)
  const pin = kind === null ? null : await (kind === 'plugin' ? PROGRESSION_PLUGIN : PROGRESSION_MOD).pin(q)
  return pin === null ? [] : [pin]
}

/** What a start of the server places: `progressionIfOn`'s, and nothing where it is off. */
export async function progressionFor(
  q: Queryable,
  serverId: string,
  revision: Progressed,
): Promise<PinnedMod[]> {
  const jars = await progressionIfOn(q, revision)
  return jars.length === 0 || (await progressionOff(q, serverId)) !== null ? [] : jars
}

/**
 * What a start that failed asks of the Fabric mod (`operations/boot.ts`'s `OwnMods`, with the
 * performance mods): whether it placed it, and the way to start once without it and back. A
 * Paper plugin that fails leaves the server starting without it, so only the mod counts.
 */
export const progressionAtStart = (q: Queryable) => ({
  placed: async (serverId: string, revision: Omit<Progressed, 'loaderVersion'>) => {
    // What a start reads of a revision has no Paper build: only the Fabric mod is asked about.
    const fabric = { ...revision, loaderVersion: null }
    return progressionKind(fabric) === 'mod' && (await progressionFor(q, serverId, fabric)).length > 0
  },
  // Never over a choice already there: an owner who turned it off in the meantime keeps theirs.
  turnOff: async (serverId: string) => {
    await q.insert(off).values({ serverId, reason: 'clash' }).onConflictDoNothing()
  },
  // Only the start's own turning off is taken back: an owner who turned it off since chose that.
  turnOn: async (serverId: string) => {
    await q.delete(off).where(and(eq(off.serverId, serverId), eq(off.reason, 'clash')))
  },
})
