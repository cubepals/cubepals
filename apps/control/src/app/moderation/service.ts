// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moderation from a server's page: the moderation tools and the chat filter switched on or off,
 * warnings, mutes and bans given and taken back, each player's history, and the escalation that
 * picks what a next offence gets. The plugins are a revision change, applied like any other plugin;
 * a punishment is live administration, recorded here and delivered by the next access sync
 * (`delivery.ts`). Helpers are an access list (`AccessService`).
 *
 * What helpers do in game stays in LibertyBans, which shows it there (`/history`); this history
 * holds what was given from Cubepals.
 */
import {
  DEFAULT_LADDER,
  type ModerationActionView,
  type ModerationKind,
  type ModerationStep,
  type ModerationView,
} from '@blockly/contracts'
import { type Db, schema, type Tx } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import {
  CHATSENTINEL,
  filtersChat,
  isModerationFile,
  LIBERTYBANS,
  LUCKPERMS,
  moderationFiles,
  pinsProject,
  runsModeration,
} from '../../minecraft/moderation.ts'
import { lockAccess } from '../access/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { ModService } from '../mods/service.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import { findServer, loadRevision, lockServer } from '../servers/persistence.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import { CHAT_FILTER } from './chat-filter.ts'
import { endOf } from './delivery.ts'

const actions = schema.serverModerationActions

/** How much of a server's history its page shows: the newest. */
const HISTORY_SHOWN = 500

export class ModerationService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #transitions: ServerTransitions
  readonly #events: EventBus
  readonly #mods: ModService

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    transitions: ServerTransitions
    events: EventBus
    mods: ModService
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#transitions = deps.transitions
    this.#events = deps.events
    this.#mods = deps.mods
  }

  async view(actor: Actor, serverId: string, now = new Date()): Promise<ModerationView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const desired = await loadRevision(this.#db, server.desiredRevisionId)
    const [head] = await this.#db
      .select({ ladder: schema.serverAccess.moderationLadder })
      .from(schema.serverAccess)
      .where(eq(schema.serverAccess.serverId, serverId))
    const rows = await this.#db
      .select()
      .from(actions)
      .where(eq(actions.serverId, serverId))
      .orderBy(desc(actions.createdAt))
      .limit(HISTORY_SHOWN)
    return {
      available: canModerate(desired),
      enabled: runsModeration(desired.mods),
      chatFilter: filtersChat(desired.mods),
      ladder: head?.ladder ?? [...DEFAULT_LADDER],
      ownLadder: (head?.ladder ?? null) !== null,
      actions: rows.map((row) => actionView(row, now)),
    }
  }

  /**
   * The moderation tools, and the chat filter with them, added to the server or taken off: their
   * plugins and Cubepals' files for them, in one change, applied as any plugin is. The chat filter
   * needs the tools, so turning the tools off turns it off too.
   */
  async setTools(
    actor: Actor,
    serverId: string,
    wanted: { enabled: boolean; chatFilter: boolean },
    requestId: string,
  ): Promise<void> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const desired = await loadRevision(this.#db, server.desiredRevisionId)
    if (!canModerate(desired))
      throw new AppError(
        'invalid_choice',
        'The moderation tools run on Paper servers, and this one plays something else.',
      )
    const chatFilter = wanted.enabled && wanted.chatFilter
    const plugins = wanted.enabled ? [LIBERTYBANS, LUCKPERMS, ...(chatFilter ? [CHATSENTINEL] : [])] : []
    const add = plugins.filter((projectId) => !pinsProject(desired.mods, projectId))
    const remove = [LIBERTYBANS, LUCKPERMS, CHATSENTINEL].filter(
      (projectId) => pinsProject(desired.mods, projectId) && !plugins.includes(projectId),
    )
    const files = [
      ...desired.files.filter((file) => !isModerationFile(file)),
      ...(wanted.enabled ? moderationFiles(chatFilter ? CHAT_FILTER : null) : []),
    ]
    const change = { add: add.map((projectId) => ({ projectId })), remove, files }
    const plan = await this.#mods.plan(actor, serverId, change)
    if (plan.kind === 'conflicts')
      throw new AppError(
        'mods_conflict',
        `The moderation tools can't run on this server yet: ${plan.conflicts.map((c) => c.mod).join(', ')}.`,
      )
    await this.#mods.apply(
      actor,
      serverId,
      change,
      plan.mods.map((mod) => mod.artifact.sha512),
      requestId,
    )
  }

  /** A warning, or a mute or ban for so many minutes or for good, given to one player. */
  async punish(
    actor: Actor,
    serverId: string,
    p: { playerUuid: string; name: string; kind: ModerationKind; minutes: number | null; reason: string },
  ): Promise<void> {
    await this.#change(actor, serverId, 'moderation.punished', async (tx, server) => {
      if (!runsModeration((await loadRevision(tx, server.desiredRevisionId)).mods))
        throw new AppError('invalid_choice', 'Turn on the moderation tools first, on the Players page.')
      await tx.insert(actions).values({
        serverId,
        playerUuid: p.playerUuid.toLowerCase(),
        playerName: p.name,
        kind: p.kind,
        reason: p.reason,
        minutes: p.kind === 'warn' ? null : p.minutes,
        state: 'pending',
        requestedBy: requestedBy(actor),
      })
    })
  }

  /**
   * Takes back a mute or ban. One the server never got, or whose time is up, is simply marked so;
   * otherwise the server is told at the next sync. A warning stays in the history.
   */
  async lift(actor: Actor, serverId: string, actionId: string, now = new Date()): Promise<void> {
    await this.#change(actor, serverId, 'moderation.lifted', async (tx) => {
      const [action] = await tx
        .select()
        .from(actions)
        .where(and(eq(actions.id, actionId), eq(actions.serverId, serverId)))
        .for('update')
      if (!action) throw new NotFound('Punishment')
      if (action.kind === 'warn') throw new AppError('invalid_choice', 'A warning stays in their history.')
      if (action.state === 'lifting' || action.state === 'lifted') return
      const end = endOf(action)
      const done = action.state === 'pending' || (end !== null && end.getTime() <= now.getTime())
      await tx
        .update(actions)
        .set(done ? { state: 'lifted', liftedAt: now, error: null } : { state: 'lifting', error: null })
        .where(eq(actions.id, actionId))
    })
  }

  /** The owner's own escalation, or Blockly's again with null. */
  async setLadder(actor: Actor, serverId: string, ladder: ModerationStep[] | null): Promise<void> {
    await this.#change(actor, serverId, 'moderation.ladder_changed', async (tx) => {
      await tx
        .update(schema.serverAccess)
        .set({ moderationLadder: ladder })
        .where(eq(schema.serverAccess.serverId, serverId))
    })
  }

  /** As an access change (§15.1): the owner's policy, audited, synced, and the page told. */
  async #change(
    actor: Actor,
    serverId: string,
    action: string,
    apply: (tx: Tx, server: MinecraftServer) => Promise<void>,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (actor.kind === 'user') await this.#policy.require(tx, server.ownerId, { kind: 'manage_access' })
      const version = await lockAccess(tx, serverId)
      await apply(tx, server)
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action,
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

/** A server the tools can run on: Paper, or plain Minecraft, which becomes Paper with them. */
const canModerate = (revision: ServerRevision) =>
  revision.modpack === null && (revision.loader === 'paper' || revision.loader === 'vanilla')

function actionView(row: typeof actions.$inferSelect, now: Date): ModerationActionView {
  const end = endOf(row)
  const over = end !== null && end.getTime() <= now.getTime()
  return {
    id: row.id,
    player: { uuid: row.playerUuid, name: row.playerName },
    kind: row.kind,
    reason: row.reason,
    minutes: row.minutes,
    status:
      row.state === 'pending'
        ? over
          ? 'over'
          : 'waiting'
        : row.state === 'delivered'
          ? over
            ? 'over'
            : 'given'
          : row.state,
    endsAt: end?.toISOString() ?? null,
    at: row.createdAt.toISOString(),
    error: row.error,
  }
}
