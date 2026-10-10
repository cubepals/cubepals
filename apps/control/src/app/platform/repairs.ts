/**
 * An admin fixing someone's server (§9): starting it, sending it to the trash or taking it back
 * out, and restoring one of its backups. Each goes the way its owner's own would, as `admin:<id>`:
 * the owner's plan still decides what may run, and the trash keeps it as long as their plan says.
 * Why the admin did it is kept in the audit log, beside what the action itself records. Stopping
 * for maintenance is the servers service's own (`stopForMaintenance`).
 */
import { type Db, schema } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type Actor, requestedBy } from '../actor.ts'
import type { BackupService } from '../backups/service.ts'
import { AppError, NotFound } from '../errors.ts'
import { findServer } from '../servers/persistence.ts'
import type { MinecraftServerService } from '../servers/service.ts'

export class ServerRepairs {
  readonly #db: Db
  readonly #servers: MinecraftServerService
  readonly #backups: BackupService

  constructor(deps: { db: Db; servers: MinecraftServerService; backups: BackupService }) {
    this.#db = deps.db
    this.#servers = deps.servers
    this.#backups = deps.backups
  }

  async start(actor: Actor, serverId: string, requestId: string, reason: string): Promise<MinecraftServer> {
    const why = this.#why(actor, reason)
    const before = await findServer(this.#db, serverId)
    const after = await this.#servers.start(actor, serverId, requestId)
    // A server already up did nothing, and nothing is recorded as done.
    if (after.version !== before?.version)
      await this.#audit(actor, 'server.admin_started', serverId, { reason: why })
    return after
  }

  /** To the trash like its owner's delete, confirmed by its name, for as long as their plan keeps it. */
  async trash(actor: Actor, serverId: string, confirmName: string, reason: string): Promise<MinecraftServer> {
    const why = this.#why(actor, reason)
    const deleted = await this.#servers.deleteServer(actor, serverId, confirmName)
    await this.#audit(actor, 'server.admin_trashed', serverId, { reason: why })
    return deleted
  }

  async untrash(actor: Actor, serverId: string, reason: string): Promise<MinecraftServer> {
    const why = this.#why(actor, reason)
    const back = await this.#servers.undeleteServer(actor, serverId)
    await this.#audit(actor, 'server.admin_untrashed', serverId, { reason: why })
    return back
  }

  async restore(
    actor: Actor,
    serverId: string,
    backup: { backupId: string; withConfiguration: boolean; acknowledgeRevoked?: boolean | undefined },
    requestId: string,
    reason: string,
  ): Promise<MinecraftServer> {
    const why = this.#why(actor, reason)
    const restoring = await this.#backups.restoreBackup(actor, serverId, backup.backupId, requestId, {
      withConfiguration: backup.withConfiguration,
      acknowledgeRevoked: backup.acknowledgeRevoked,
    })
    await this.#audit(actor, 'server.admin_restored', serverId, { reason: why, backupId: backup.backupId })
    return restoring
  }

  /** Only an admin, and only saying why: anyone else finds nothing here. */
  #why(actor: Actor, reason: string): string {
    if (actor.kind !== 'admin') throw new NotFound('Server')
    const why = reason.trim()
    if (why.length === 0) throw new AppError('invalid_choice', 'Say why.')
    return why
  }

  async #audit(actor: Actor, action: string, serverId: string, data: Record<string, unknown>) {
    await this.#db
      .insert(schema.auditLog)
      .values({ actor: requestedBy(actor), action, subjectType: 'server', subjectId: serverId, data })
  }
}
