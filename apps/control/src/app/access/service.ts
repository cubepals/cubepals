import { type Db, schema, type Tx } from '@blockly/db'
import type { AccessEntry, AccessList, PlayerRef } from '../../domain/access/access.ts'
import { entryKey } from '../../domain/access/access.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'
import { findServer, loadRevision, lockServer } from '../servers/persistence.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import { identityFor } from './identity.ts'
import { deleteEntry, lockAccess, readAccess, setWhitelistPending, upsertEntry } from './persistence.ts'

/**
 * Live administration: who can join, who operates, who is banned. Every change is recorded as
 * pending and delivered by an access sync — immediately when the server runs, at its next boot
 * otherwise. Nothing here creates a revision or restarts anything.
 */
export class AccessService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #profiles: PlayerProfiles
  readonly #transitions: ServerTransitions
  readonly #events: EventBus

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    profiles: PlayerProfiles
    transitions: ServerTransitions
    events: EventBus
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#profiles = deps.profiles
    this.#transitions = deps.transitions
    this.#events = deps.events
  }

  async add(actor: Actor, serverId: string, list: AccessList, name: string, reason?: string): Promise<void> {
    const player = await this.#resolve(actor, serverId, name)
    await this.#change(actor, serverId, async (tx, current) => {
      const existing = current.find((e) => e.list === list && e.player.uuid === player.uuid)
      if (existing?.state === 'active' || existing?.state === 'pending_add') return
      const entry: AccessEntry = {
        list,
        player,
        // Removing and re-adding before delivery cancels out.
        state: existing?.state === 'pending_remove' ? 'active' : 'pending_add',
        origin: 'blockly',
        details: reason ? { reason } : {},
        error: null,
      }
      await upsertEntry(tx, serverId, entry, requestedBy(actor))
    })
  }

  async remove(actor: Actor, serverId: string, list: AccessList, playerUuid: string): Promise<void> {
    const uuid = normalizeUuid(playerUuid)
    await this.#change(actor, serverId, async (tx, current) => {
      const existing = current.find((e) => entryKey(e.list, e.player.uuid) === entryKey(list, uuid))
      if (!existing || existing.state === 'pending_remove') return
      // Never delivered: forget it. Delivered or rejected: take it off the server.
      if (existing.state === 'pending_add' || existing.state === 'rejected')
        await deleteEntry(tx, serverId, existing)
      else
        await upsertEntry(
          tx,
          serverId,
          { ...existing, state: 'pending_remove', error: null },
          requestedBy(actor),
        )
    })
  }

  async setWhitelistEnabled(actor: Actor, serverId: string, enabled: boolean): Promise<void> {
    await this.#change(actor, serverId, async (tx) => {
      await setWhitelistPending(tx, serverId, enabled)
    })
  }

  /**
   * The owner opened the access page (§15.1): a full sync, so what players changed in game shows
   * up there. At most once a minute; nothing while the server is off, where the files wait for
   * its next boot. Never a revision, never a restart.
   */
  async refresh(actor: Actor, serverId: string, now = new Date()): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.lifecycle.status !== 'running') return
      await this.#transitions.enqueue(tx, server, 'access_sync', {
        requestedBy: requestedBy(actor),
        idempotencyKey: `access_refresh:${Math.floor(now.getTime() / 60_000)}`,
      })
    })
  }

  /**
   * The player a name means to this server, as it runs from its next start on. Where it checks
   * accounts, that is the account with the name, and a name nobody owns is refused. Where it
   * doesn't, the name is the player, capitals and all, and needs no account.
   */
  async #resolve(actor: Actor, serverId: string, name: string): Promise<PlayerRef> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const { onlineMode } = (await loadRevision(this.#db, server.desiredRevisionId)).settings
    const player = await identityFor(name, onlineMode, this.#profiles)
    if (player === null) throw new AppError('unknown_player', `There is no Minecraft player called ${name}.`)
    return player
  }

  async #change(actor: Actor, serverId: string, apply: (tx: Tx, current: AccessEntry[]) => Promise<void>) {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (actor.kind === 'user') await this.#policy.require(tx, server.ownerId, { kind: 'manage_access' })
      const version = await lockAccess(tx, serverId)
      const { record } = await readAccess(tx, serverId)
      await apply(tx, record.entries)
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'access.changed',
        subjectType: 'server',
        subjectId: serverId,
      })
      await this.#transitions.enqueue(tx, server, 'access_sync', {
        requestedBy: requestedBy(actor),
        idempotencyKey: `access_sync:${crypto.randomUUID()}`,
      })
      await this.#events.publish(tx, { type: 'access_changed', serverId, ownerId: server.ownerId, version })
    })
  }
}
