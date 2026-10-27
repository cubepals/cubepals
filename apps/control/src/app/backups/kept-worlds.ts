// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world brought to a server, kept as a backup of it (docs/world-import.md): the folder it is
 * given there, matched to one the server already has where it is that world, and the rows that
 * record it. A server's folder with several worlds keeps each this way. How a world is read and
 * written is `world-imports.ts`'s; this is only where it lands and how it is recorded.
 */
import { NAME_MAX_LENGTH } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import type { Tx } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { nextLevelName } from '../../domain/world/world.ts'
import { isRelease } from '../../minecraft/versions.ts'
import { isLevelName } from '../../minecraft/worlds.ts'
import { insertWorld, type listWorlds, markPruned, markWorldDeleted } from '../worlds/persistence.ts'
import { insertArchive } from './persistence.ts'
import type { Read } from './world-reading.ts'

type WorldRow = Awaited<ReturnType<typeof listWorlds>>[number]

/**
 * The folder a world gets on its server: the one it has where it is a world the server already
 * has (same folder and seed, or a Cubepals download of one without a seed), else its own folder's
 * name where that is one Blockly makes and no other world has it, else the next free one.
 */
export function levelFor(
  read: Read,
  worlds: readonly WorldRow[],
  taken: readonly string[],
  fromCubepals: boolean,
): { levelName: string; known: WorldRow | undefined } {
  const known = worlds.find(
    (world) =>
      world.levelName === read.world.folderName &&
      (world.seed === null ? fromCubepals : world.seed === read.facts.seed),
  )
  const levelName =
    known?.levelName ??
    (isLevelName(read.world.folderName) && !taken.includes(read.world.folderName)
      ? read.world.folderName
      : nextLevelName([...taken]))
  return { levelName, known }
}

/** A world written as a backup, ready to record. */
export interface KeptWorld {
  read: Read
  levelName: string
  /** The server's world it is a backup of, where it already has it. */
  known: string | null
  /** What the world is called where the server has never had it. */
  name: string | null
  backupId: string
  key: string
  sizeBytes: number
}

/**
 * The world's backup recorded on `server`, and the world itself where the server never had it,
 * not on the server until the backup is restored.
 */
export async function recordKept(
  tx: Tx,
  server: MinecraftServer,
  kept: KeptWorld,
  at: { now: Date; days: number; serverVersion: string },
): Promise<void> {
  const { facts } = kept.read
  let worldId = kept.known
  if (worldId === null) {
    worldId = (
      await insertWorld(tx, {
        serverId: server.id,
        levelName: kept.levelName,
        name: (kept.name || facts.name || 'Uploaded world').slice(0, NAME_MAX_LENGTH),
        seed: facts.seed,
        levelType: facts.levelType,
        hardcore: facts.hardcore,
        generatedOnVersion: isRelease(facts.gameVersion) ? facts.gameVersion : at.serverVersion,
      })
    ).id
    await markWorldDeleted(tx, worldId, at.now)
    await markPruned(tx, [worldId], at.now)
  }
  await insertArchive(tx, {
    id: kept.backupId,
    serverId: server.id,
    worldId,
    revisionId: server.desiredRevisionId,
    trigger: 'uploaded',
    status: 'ready',
    archiveKey: kept.key,
    sizeBytes: kept.sizeBytes,
    expiresAt: new Date(at.now.getTime() + at.days * DAY_MS),
    worldFacts: {
      seed: facts.seed,
      levelType: facts.levelType,
      hardcore: facts.hardcore,
      gameVersion: facts.gameVersion,
    },
  })
}

/** A server's other world as its owner knows it: by its folder, as a server with several names them. */
const called = (read: Read) => read.world.folderName || read.facts.name || 'a world'

/** What its owner reads of the other worlds of a server's folder, kept beside the one brought. */
export function othersNotes(others: readonly Read[], left: readonly string[]): string[] {
  const names = others.map(called)
  return [
    ...(names.length > 0
      ? [
          `Also kept ${names.join(', ')}, the server’s other ${names.length === 1 ? 'world' : 'worlds'}, as ${names.length === 1 ? 'a backup' : 'backups'} to restore when you want to play ${names.length === 1 ? 'it' : 'them'}.`,
        ]
      : []),
    ...left,
  ]
}

/** What its owner reads of the other worlds of a server's folder, brought for a new server: one starts it. */
export function othersForNewServer(others: readonly Read[]): string[] {
  const names = others.map(called)
  if (names.length === 0) return []
  return [
    `The file also holds ${names.join(', ')}. Once the server is made, upload the same file on its Backups page to keep ${names.length === 1 ? 'it' : 'them'} too.`,
  ]
}
