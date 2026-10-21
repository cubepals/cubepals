// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stop cheaters from a server's Players page and from the server itself: the owner's switch, which
 * restarts a running server as the moderation switches do; "Use Cubepals' settings" in place of
 * the owner's own Grim file; the players removed, as the server's reporter tells them; and the ban
 * a player earns by sending what no game can, again and again, where the server runs the
 * moderation tools. That ban is recorded like any other (`ModerationService`) and delivered by the
 * next access sync, and its owner can lift it from the player's page.
 *
 * Automatic changes (publishing, the migration) are not here: they never restart a server, and
 * arrive at its next start (`persistence.ts`, `servers/specs.ts`).
 */
import {
  REMOVAL_REASONS,
  type RemovalReason,
  type RemovalView,
  type StopCheatersView,
} from '@blockly/contracts'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import type { ServerJoinEvent } from '@blockly/contracts/join-records'
import { type Db, schema, type Tx } from '@blockly/db'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { runsModeration } from '../../minecraft/moderation.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { grimFor } from '../compat/service.ts'
import { AppError } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import { findServer, loadRevision, lockServer } from '../servers/persistence.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import { tuning } from '../tuning.ts'
import {
  countRemovals,
  insertRemoval,
  loadStopCheaters,
  recentRemovals,
  removalsOf,
  saveStopCheaters,
} from './persistence.ts'
import { effective } from './rule.ts'

/** How many removals the Players page lists: the newest. */
const REMOVALS_SHOWN = 20

/** Who a ban Stop cheaters records is requested by, as its history keeps it. */
export const STOP_CHEATERS_ACTOR = 'system:stop-cheaters'

/** The reason a player banned by Stop cheaters reads. */
export const BAN_REASON = 'Sent something the game can’t, again and again.'

export class StopCheatersService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #transitions: ServerTransitions
  readonly #events: EventBus

  constructor(deps: { db: Db; policy: AccessPolicy; transitions: ServerTransitions; events: EventBus }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#transitions = deps.transitions
    this.#events = deps.events
  }

  /** The switch as the Players page shows it. */
  async viewOf(actor: Actor, serverId: string): Promise<StopCheatersView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    return this.view(server, await loadRevision(this.#db, server.desiredRevisionId))
  }

  /** The switch as the Players page shows it, for a server already authorized. */
  async view(server: MinecraftServer, desired: ServerRevision, now = new Date()): Promise<StopCheatersView> {
    const row = await loadStopCheaters(this.#db, server.id)
    const { on, why } = effective(row)
    const grim = await grimFor(this.#db, desired)
    const [runtime] = await this.#db
      .select({ mark: sql<string | null>`${schema.serverRuntimes.applied}->>'stopCheaters'` })
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, server.id))
    const recent = await recentRemovals(this.#db, server.id, REMOVALS_SHOWN)
    return {
      effective: on,
      setting: row.setting,
      why,
      own: on && runtime?.mark === 'own',
      available:
        grim.kind === 'placed'
          ? { kind: 'yes' }
          : grim.kind === 'release'
            ? { kind: 'release', release: desired.gameVersion }
            : { kind: 'modded' },
      removals: recent.map(removalView),
      today: await countRemovals(this.#db, server.id, new Date(now.getTime() - (now.getTime() % DAY_MS))),
    }
  }

  /**
   * The owner's switch: `on` or `off`, which no automation changes after. A running server restarts
   * for it, as the moderation switches do; a stopped one has it at its next start.
   */
  async set(actor: Actor, serverId: string, on: boolean, requestId: string): Promise<void> {
    await this.#change(
      actor,
      serverId,
      requestId,
      on ? 'moderation.stop_cheaters_on' : 'moderation.stop_cheaters_off',
      async (tx, desired) => {
        const grim = (await grimFor(tx, desired)).kind
        if (on && grim === 'modded') throw new AppError('invalid_choice', MODDED)
        const was = effective(await loadStopCheaters(tx, serverId)).on
        await saveStopCheaters(tx, serverId, { setting: on ? 'on' : 'off', reason: null, takeOver: false })
        // Nothing to restart for where it already ran that way, or where its release has no Grim yet.
        return was !== on && grim === 'placed'
      },
    )
  }

  /** Cubepals' punishments in place of the owner's own Grim settings, which are kept aside. */
  async useOurs(actor: Actor, serverId: string, requestId: string): Promise<void> {
    await this.#change(actor, serverId, requestId, 'moderation.stop_cheaters_ours', async (tx) => {
      if (!effective(await loadStopCheaters(tx, serverId)).on)
        throw new AppError('invalid_choice', 'Turn on Stop cheaters first.')
      await saveStopCheaters(tx, serverId, { takeOver: true })
      return true
    })
  }

  /** One player's removals on a server, newest first, for their page. */
  async removalsOf(actor: Actor, serverId: string, playerUuid: string): Promise<RemovalView[]> {
    authorize(actor, await findServer(this.#db, serverId))
    return (await removalsOf(this.#db, serverId, playerUuid)).map(removalView)
  }

  /**
   * The `removed` events a server's reporter posted: each kept, and a player whose removals for
   * sending what no game can reach the configured rule banned, where the moderation tools run.
   */
  async recordRemovals(serverId: string, events: readonly ServerJoinEvent[]): Promise<void> {
    for (const event of events) {
      const reason = REMOVAL_REASONS.find((r) => r === event.reason)
      if (event.kind !== 'removed' || reason === undefined || event.uuid === undefined) continue
      const uuid = event.uuid.toLowerCase()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) continue
      await this.#db.transaction(async (tx) => {
        const at = new Date(event.at)
        const added = await insertRemoval(tx, {
          serverId,
          playerUuid: uuid,
          playerName: event.name ?? '',
          reason,
          at,
        })
        // A batch sent again brings nothing new to count towards a ban.
        if (added) await this.#maybeBan(tx, serverId, { uuid, name: event.name ?? '' }, reason, at)
      })
    }
  }

  async #maybeBan(
    tx: Tx,
    serverId: string,
    player: { uuid: string; name: string },
    reason: RemovalReason,
    at: Date,
  ): Promise<void> {
    const rule = tuning().stopCheaters?.ban
    if (rule === undefined || reason !== rule.reason) return
    const server = await lockServer(tx, serverId)
    if (server === null || server.deletedAt !== null) return
    if (!runsModeration((await loadRevision(tx, server.desiredRevisionId)).mods)) return
    const since = new Date(at.getTime() - rule.withinMinutes * MINUTE_MS)
    const removed = await countRemovals(tx, serverId, since, { playerUuid: player.uuid, reason })
    if (removed < rule.removals) return
    const actions = schema.serverModerationActions
    // One ban for a run of removals: none while one given in the same span stands.
    const [given] = await tx
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.serverId, serverId),
          eq(actions.playerUuid, player.uuid),
          eq(actions.requestedBy, STOP_CHEATERS_ACTOR),
          gte(actions.createdAt, since),
        ),
      )
      .limit(1)
    if (given !== undefined) return
    await tx.insert(actions).values({
      serverId,
      playerUuid: player.uuid,
      playerName: player.name,
      kind: 'ban',
      reason: BAN_REASON,
      minutes: rule.minutes,
      state: 'pending',
      requestedBy: STOP_CHEATERS_ACTOR,
    })
    await tx.insert(schema.auditLog).values({
      actor: STOP_CHEATERS_ACTOR,
      action: 'moderation.punished',
      subjectType: 'server',
      subjectId: serverId,
      data: { playerUuid: player.uuid, kind: 'ban', minutes: rule.minutes },
    })
    await this.#transitions.enqueue(tx, server, 'access_sync', {
      requestedBy: STOP_CHEATERS_ACTOR,
      idempotencyKey: `access_sync:${crypto.randomUUID()}`,
    })
  }

  /** A change of the owner's: their policy, audited, and a running server restarted to take it. */
  async #change(
    actor: Actor,
    serverId: string,
    requestId: string,
    action: string,
    /** Whether a running server restarts for it. */
    apply: (tx: Tx, desired: ServerRevision) => Promise<boolean>,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (actor.kind === 'user') await this.#policy.require(tx, server.ownerId, { kind: 'manage_access' })
      const restarts = await apply(tx, await loadRevision(tx, server.desiredRevisionId))
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action,
        subjectType: 'server',
        subjectId: serverId,
      })
      const moved =
        restarts && server.lifecycle.status === 'running'
          ? (
              await this.#transitions.command(
                tx,
                server,
                { type: 'apply' },
                {
                  requestedBy: requestedBy(actor),
                  idempotencyKey: `apply:${requestId}`,
                  input: { boot: true },
                },
              )
            ).server
          : server
      await this.#events.publish(tx, {
        type: 'server_changed',
        serverId,
        ownerId: server.ownerId,
        status: moved.lifecycle.status,
        version: moved.version,
      })
    })
  }
}

const removalView = (r: typeof schema.serverRemovals.$inferSelect): RemovalView => ({
  player: { uuid: r.playerUuid, name: r.playerName },
  reason: r.reason,
  at: r.at.toISOString(),
})

const MODDED =
  'Stop cheaters runs on plain Minecraft and Paper servers. Mods change how players move, so it can’t tell a cheat from a mod here.'
