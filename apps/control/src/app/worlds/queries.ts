// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's worlds as its owner's page lists them, and what starting a fresh one would do. Not
 * making, switching or deleting worlds (`service.ts`).
 */
import { type FreshStartView, isLevelType, type LevelType, type WorldView } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { type Actor, authorize } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { findServer, loadRuntime } from '../servers/persistence.ts'
import { freshStartOf } from './fresh-start.ts'
import { listWorlds } from './persistence.ts'

/** A world's stored type, as the page names it; one Blockly never makes is a bug, not a world. */
function knownType(type: string): LevelType {
  if (!isLevelType(type)) throw new Error(`A world of a type Blockly doesn't make: ${type}`)
  return type
}

export class WorldQueries {
  readonly #db: Db
  readonly #providers: readonly string[]

  constructor(deps: { db: Db; providers: readonly string[] }) {
    this.#db = deps.db
    this.#providers = deps.providers
  }

  /** The server's worlds, oldest first; deleted ones are gone from here. */
  async list(actor: Actor, serverId: string): Promise<WorldView[]> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const { applied } = await loadRuntime(this.#db, server.id, this.#providers)
    const backups = (await listBackups(this.#db, server.id)).filter((b) => b.status === 'ready')
    return (await listWorlds(this.#db, server.id))
      .filter((world) => world.deletedAt === null)
      .map((world) => ({
        id: world.id,
        name: world.name,
        levelType: knownType(world.levelType),
        seed: world.seed,
        hardcore: world.hardcore,
        generatedOnVersion: world.generatedOnVersion,
        createdAt: world.createdAt.toISOString(),
        active: world.id === server.activeWorldId,
        running: world.id === applied?.worldId,
        backups: backups.filter((b) => b.worldId === world.id).length,
      }))
  }

  /** What starting over is on this server, and what the world it makes is called. */
  async freshStart(actor: Actor, serverId: string): Promise<FreshStartView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const { kind, name, leaving, hearts, islands } = await freshStartOf(this.#db, server)
    return { kind, name, leaving, hearts, islands }
  }
}
