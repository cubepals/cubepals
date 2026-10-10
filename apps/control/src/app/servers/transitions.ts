// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Tx } from '@blockly/db'
import {
  type Command,
  decide,
  type OperationKind,
  type Outcome,
  type ServerStatus,
  transition,
} from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { AppError } from '../errors.ts'
import { insertOperation, type OperationRecord } from '../operations/persistence.ts'
import type { EventBus } from '../ports/events.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { saveLifecycle } from './persistence.ts'

/** How many times the queue retries an operation before the domain records the failure. */
const RETRIES: Record<OperationKind, number> = {
  provision: 4,
  start: 2,
  stop: 2,
  restart: 2,
  apply: 1,
  relocate: 1,
  backup: 2,
  archive: 2,
  restore: 1,
  access_sync: 0,
  prune_worlds: 3,
  decommission: 8,
  purge: 8,
  // Every step is safe to run again: a store resumes from the copy it verified, and letting
  // storage go that is already gone counts as done.
  store: 3,
  // A wake that fails puts the world back, stored, whole: the owner or the next join tries again.
  unstore: 0,
}

export interface OperationRequest {
  requestedBy: string
  idempotencyKey: string
  input?: Record<string, unknown>
}

/**
 * The single writer of server lifecycle. Services use `command` to accept requests; workers use
 * `outcome` to report results. Both decide through the pure state machine, save, and emit inside
 * the caller's transaction.
 */
/**
 * Why a server can't do something right now, in the words of what it is doing: never its status's
 * own name ("a server that is provisioning"), which reached owners until 2026-09-27.
 */
export function notNow(status: ServerStatus): string {
  switch (status) {
    case 'stored':
    case 'storing':
      return 'Wake it to change this. Its world comes back in a couple of minutes.'
    case 'deleted':
    case 'purged':
      return 'This server is in the trash. Restore it to use it again.'
    case 'provisioning':
      return 'Your server is still being set up. Try this once it’s running.'
    case 'starting':
      return 'Your server is starting. Try this once it’s running.'
    case 'stopping':
      return 'Your server is stopping. Try this once it has.'
    case 'updating':
      return 'Your server is taking a change. Try this once it’s done.'
    case 'restoring':
      return 'Your server is being restored from a backup. Try this once it’s done.'
    case 'relocating':
      return 'Your server is moving. Try this once it’s done.'
    case 'running':
      return 'Stop the server first.'
    case 'stopped':
      return 'Start the server first.'
    case 'failed':
      return 'Your server didn’t start last time. Start it again, or restore a backup.'
  }
}

export class ServerTransitions {
  readonly #events: EventBus
  readonly #jobs: JobQueue

  constructor(events: EventBus, jobs: JobQueue) {
    this.#events = events
    this.#jobs = jobs
  }

  async command(
    tx: Tx,
    server: MinecraftServer,
    command: Command,
    request: OperationRequest,
  ): Promise<{ server: MinecraftServer; operation: OperationRecord | null }> {
    const decision = decide(server.lifecycle, command)
    if (decision.kind === 'invalid') throw new AppError('invalid_transition', notNow(server.lifecycle.status))
    if (decision.kind === 'noop') return { server, operation: null }

    const moved = decision.to === server.lifecycle ? server : await this.#save(tx, server, decision.to)
    const operation =
      decision.operation === null ? null : await this.enqueue(tx, moved, decision.operation, request)
    return { server: moved, operation }
  }

  async outcome(tx: Tx, server: MinecraftServer, outcome: Outcome): Promise<MinecraftServer> {
    return this.#save(tx, server, transition(server.lifecycle, outcome))
  }

  /** Queues an operation that is not a status change, such as an access sync. */
  async enqueue(
    tx: Tx,
    server: MinecraftServer,
    kind: OperationKind,
    request: OperationRequest,
  ): Promise<OperationRecord> {
    const { record, created } = await insertOperation(tx, {
      serverId: server.id,
      kind,
      input: request.input ?? {},
      requestedBy: request.requestedBy,
      idempotencyKey: request.idempotencyKey,
    })
    if (created) {
      await this.#jobs.enqueue(tx, { operationId: record.id, serverId: server.id, retryLimit: RETRIES[kind] })
      await this.#events.publish(tx, {
        type: 'operation_progress',
        serverId: server.id,
        ownerId: server.ownerId,
        operationId: record.id,
        kind,
        step: null,
        status: 'queued',
      })
    }
    return record
  }

  async #save(
    tx: Tx,
    server: MinecraftServer,
    lifecycle: MinecraftServer['lifecycle'],
  ): Promise<MinecraftServer> {
    const saved = await saveLifecycle(tx, server, lifecycle)
    await this.#events.publish(tx, {
      type: 'server_changed',
      serverId: saved.id,
      ownerId: saved.ownerId,
      status: saved.lifecycle.status,
      version: saved.version,
    })
    return saved
  }
}
