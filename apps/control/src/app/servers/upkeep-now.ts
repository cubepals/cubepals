// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Upkeep the sweeps do on their own, done now for one server when an operator asks
 * (`interfaces/operator/ops.ts`): its world rested in the archive store, through the `store`
 * operation the store sweep queues for an idle world, or a server in the trash purged, through the
 * `purge` the purge sweep queues once its time there is up. Owners never ask for either: Blockly
 * rests worlds on its own, and the trash's window is what they were promised. Which servers the
 * sweeps take is `operations/schedules/`'s; the work itself is the operations'.
 */
import { type Db, schema, type Tx } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type Actor, authorize, requestedBy, runsThePlatform } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { lockServer, purgeSooner } from './persistence.ts'
import type { ServerTransitions } from './transitions.ts'

export class UpkeepNow {
  readonly #db: Db
  readonly #transitions: Pick<ServerTransitions, 'enqueue'>
  readonly #events: Pick<EventBus, 'publish'>

  constructor(deps: {
    db: Db
    transitions: Pick<ServerTransitions, 'enqueue'>
    events: Pick<EventBus, 'publish'>
  }) {
    this.#db = deps.db
    this.#transitions = deps.transitions
    this.#events = deps.events
  }

  /**
   * A stopped server's world to the archive store now, its machine and volume let go, however
   * recently it was played. The `store` operation checks the rest again under the server's lock,
   * as it does for the sweep: resting can be paused, and a start asked for meanwhile wins.
   */
  async rest(actor: Actor, serverId: string, requestId: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = this.#authorize(actor, await lockServer(tx, serverId))
      const status = server.lifecycle.status
      if (status === 'stored' || status === 'storing') return server
      if (status !== 'stopped')
        throw new AppError('invalid_transition', 'Only a stopped server rests. Stop it first.')
      await this.#transitions.enqueue(tx, server, 'store', {
        requestedBy: requestedBy(actor),
        idempotencyKey: `store:now:${requestId}`,
        input: { now: true },
      })
      await this.#audit(tx, actor, 'server.rest_requested', serverId)
      return server
    })
  }

  /**
   * A server in the trash purged now rather than when its time there is up: its runtime, storage
   * and stored copy go for good, and it can no longer be taken back out. Like a delete, it takes
   * the server's name, typed exactly.
   */
  async purge(actor: Actor, serverId: string, confirmName: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = this.#authorize(actor, await lockServer(tx, serverId))
      if (confirmName.trim() !== server.name.trim())
        throw new AppError('confirmation_mismatch', 'Type the server’s name exactly to purge it.')
      if (server.lifecycle.status === 'purged') return server
      if (server.lifecycle.status !== 'deleted')
        throw new AppError('invalid_transition', 'Only a server in the trash is purged. Send it there first.')
      const sooner = await purgeSooner(tx, server, new Date())
      await this.#events.publish(tx, {
        type: 'server_changed',
        serverId: sooner.id,
        ownerId: sooner.ownerId,
        status: sooner.lifecycle.status,
        version: sooner.version,
      })
      await this.#transitions.enqueue(tx, sooner, 'purge', {
        requestedBy: requestedBy(actor),
        idempotencyKey: `purge:now:v${server.version}`,
      })
      await this.#audit(tx, actor, 'server.purge_requested', serverId)
      return sooner
    })
  }

  /** Only whoever runs the platform asks for either; to anyone else the server isn't there. */
  #authorize(actor: Actor, server: MinecraftServer | null): MinecraftServer {
    if (!runsThePlatform(actor)) throw new NotFound('Server')
    return authorize(actor, server)
  }

  async #audit(tx: Tx, actor: Actor, action: string, serverId: string) {
    await tx
      .insert(schema.auditLog)
      .values({ actor: requestedBy(actor), action, subjectType: 'server', subjectId: serverId, data: {} })
  }
}
