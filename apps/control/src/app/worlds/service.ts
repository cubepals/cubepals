import { type Db, schema, type Tx } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { nextLevelName } from '../../domain/world/world.ts'
import type { LevelType } from '../../minecraft/worlds.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { loadRevision, loadRuntime, lockServer, setDesired } from '../servers/persistence.ts'
import { notNow, type ServerTransitions } from '../servers/transitions.ts'
import { freshStartOf } from './fresh-start.ts'
import { awaitingPrune, insertWorld, listWorlds, markWorldDeleted } from './persistence.ts'

export interface NewWorld {
  name: string
  seed?: string | undefined
  levelType: LevelType
  hardcore: boolean
}

/**
 * Worlds (§4): a server has one active world. A new world, or another one, applies like any
 * configuration change: a running server restarts into it, with a snapshot first. Old worlds stay
 * until deleted; their directories go at the next chance the server runs (`prune_worlds`).
 */
export class WorldService {
  readonly #db: Db
  readonly #transitions: ServerTransitions
  readonly #events: EventBus
  readonly #providers: readonly string[]

  constructor(deps: {
    db: Db
    transitions: ServerTransitions
    events: EventBus
    providers: readonly string[]
  }) {
    this.#db = deps.db
    this.#transitions = deps.transitions
    this.#events = deps.events
    this.#providers = deps.providers
  }

  async createWorld(
    actor: Actor,
    serverId: string,
    world: NewWorld,
    requestId: string,
  ): Promise<MinecraftServer> {
    const name = world.name.trim()
    if (name.length === 0 || name.length > 40)
      throw new AppError('invalid_name', 'Name the world in 1 to 40 characters.')
    return this.#switch(actor, serverId, requestId, 'server.world_created', async (tx, server) => {
      const existing = await listWorlds(tx, server.id)
      const desired = await loadRevision(tx, server.desiredRevisionId)
      return insertWorld(tx, {
        serverId: server.id,
        levelName: nextLevelName(existing.map((w) => w.levelName)),
        name,
        seed: world.seed?.trim() || null,
        levelType: world.levelType,
        hardcore: world.hardcore,
        generatedOnVersion: desired.gameVersion,
      })
    })
  }

  /**
   * Starting over in one step, as `freshStartOf` reads it for this server: a fresh world from a
   * random seed, switched to, with the one it leaves kept to switch back to. A new season also
   * resets everyone's hearts, which takes the server running: the update forgets them after its
   * snapshot, so that snapshot holds the season that ended.
   */
  freshStart(actor: Actor, serverId: string, requestId: string): Promise<MinecraftServer> {
    return this.#switch(actor, serverId, requestId, 'server.fresh_start', async (tx, server) => {
      const start = await freshStartOf(tx, server)
      if (start.kind === 'season' && server.lifecycle.status !== 'running')
        throw new AppError(
          'invalid_transition',
          server.lifecycle.status === 'stopped'
            ? 'Start the server first, so Cubepals can reset everyone’s hearts.'
            : notNow(server.lifecycle.status),
        )
      const desired = await loadRevision(tx, server.desiredRevisionId)
      const world = await insertWorld(tx, {
        serverId: server.id,
        levelName: nextLevelName((await listWorlds(tx, server.id)).map((w) => w.levelName)),
        name: start.name,
        seed: null,
        levelType: start.from?.levelType ?? 'minecraft:normal',
        hardcore: start.from?.hardcore ?? false,
        generatedOnVersion: desired.gameVersion,
      })
      return { ...world, input: start.kind === 'season' ? { resetHearts: true } : {} }
    })
  }

  switchWorld(actor: Actor, serverId: string, worldId: string, requestId: string): Promise<MinecraftServer> {
    return this.#switch(actor, serverId, requestId, 'server.world_switched', async (tx, server) => {
      const world = (await listWorlds(tx, server.id)).find((w) => w.id === worldId)
      if (world === undefined || world.deletedAt !== null) throw new NotFound('World')
      return world
    })
  }

  /** Not the world the server runs or should run; its directories go once the server runs. */
  async deleteWorld(actor: Actor, serverId: string, worldId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const world = (await listWorlds(tx, server.id)).find((w) => w.id === worldId)
      if (world === undefined || world.deletedAt !== null) throw new NotFound('World')
      const { applied } = await loadRuntime(tx, server.id, this.#providers)
      if (world.id === server.activeWorldId || world.id === applied?.worldId)
        throw new AppError('invalid_choice', 'Switch to another world before deleting this one.')
      await markWorldDeleted(tx, world.id, new Date())
      if (server.lifecycle.status === 'running') await enqueuePrune(tx, this.#transitions, server)
      await this.#audit(tx, actor, 'server.world_deleted', server.id, { worldId, name: world.name })
    })
  }

  async #switch(
    actor: Actor,
    serverId: string,
    requestId: string,
    action: string,
    /** The world to run, and anything the update that moves to it does besides. */
    pick: (
      tx: Tx,
      server: MinecraftServer,
    ) => Promise<{ id: string; name: string; input?: Record<string, unknown> }>,
  ): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const world = await pick(tx, server)
      if (world.id === server.activeWorldId) return server
      const moved = await setDesired(tx, server, { activeWorldId: world.id })
      const result = await this.#transitions.command(
        tx,
        moved,
        { type: 'apply' },
        {
          requestedBy: requestedBy(actor),
          idempotencyKey: `apply:${requestId}`,
          input: { ...world.input, worldId: world.id },
        },
      )
      // A stopped server keeps the switch for its next start; nothing else told its pages.
      if (result.server === moved)
        await this.#events.publish(tx, {
          type: 'server_changed',
          serverId: moved.id,
          ownerId: moved.ownerId,
          status: moved.lifecycle.status,
          version: moved.version,
        })
      await this.#audit(tx, actor, action, server.id, { worldId: world.id, name: world.name })
      return result.server
    })
  }

  async #audit(tx: Tx, actor: Actor, action: string, serverId: string, data: Record<string, unknown>) {
    await tx.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action,
      subjectType: 'server',
      subjectId: serverId,
      data,
    })
  }
}

/** Deleted worlds still on the volume are removed the next time the server runs. */
export async function enqueuePrune(
  tx: Tx,
  transitions: ServerTransitions,
  server: MinecraftServer,
): Promise<void> {
  if ((await awaitingPrune(tx, server.id, server.activeWorldId)).length === 0) return
  await transitions.enqueue(tx, server, 'prune_worlds', {
    requestedBy: 'system:prune',
    idempotencyKey: `prune_worlds:${crypto.randomUUID()}`,
  })
}
