// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Db, schema } from '@blockly/db'
import { isPlainCommand, refusedCommand } from '../../minecraft/console.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { ServerConsole } from '../ports/minecraft.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { findServer, loadRuntime } from '../servers/persistence.ts'
import type { RuntimeSpecs } from '../servers/specs.ts'
import { notNow } from '../servers/transitions.ts'

/** Commands people type into the console: checked, audited, then sent to the running server. */
export class ConsoleService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #runtime: Runtimes
  readonly #console: ServerConsole
  readonly #specs: RuntimeSpecs

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    runtime: Runtimes
    console: ServerConsole
    specs: RuntimeSpecs
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#runtime = deps.runtime
    this.#console = deps.console
    this.#specs = deps.specs
  }

  async run(actor: Actor, serverId: string, command: string): Promise<string> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const text = command.trim().replace(/^\//, '')
    if (!isPlainCommand(text)) throw new AppError('command_refused', 'Commands are one line of plain text.')
    const refusal = refusedCommand(text)
    if (refusal) throw new AppError('command_refused', refusal)
    if (server.lifecycle.status === 'deleted' || server.lifecycle.status === 'purged')
      throw new AppError('server_not_running', notNow(server.lifecycle.status))
    if (server.lifecycle.status !== 'running')
      throw new AppError('server_not_running', 'Start the server to run commands.')

    await this.#db.transaction(async (tx) => {
      // Owners are held to their standing, restrictions and rate; an admin's command is audited.
      if (actor.kind === 'user') await this.#policy.require(tx, server.ownerId, { kind: 'console_command' })
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'console.command',
        subjectType: 'server',
        subjectId: serverId,
        data: { command: text },
      })
    })

    const { handle } = await loadRuntime(this.#db, serverId, this.#runtime.providers)
    if (handle === null) throw new AppError('server_not_running', 'Start the server to run commands.')
    return this.#console.run(
      {
        endpoint: this.#runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
        passwords: this.#specs.rconPasswords(serverId),
      },
      text,
    )
  }
}
