// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { FreshStartView, WorldView } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { type Actor, authorize } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { findServer, loadRuntime } from '../servers/persistence.ts'
import { freshStartOf } from './fresh-start.ts'
import { listWorlds } from './persistence.ts'

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
        levelType: world.levelType as WorldView['levelType'],
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
    const { kind, name, leaving, hearts } = await freshStartOf(this.#db, server)
    return { kind, name, leaving, hearts }
  }
}
