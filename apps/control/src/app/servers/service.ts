import { SERVER_ICONS, SERVER_TAGS } from '@blockly/contracts'
import { type Db, schema, type Tx } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { type RevisionDraft, welcome } from '../../domain/revision/revision.ts'
import { type Command, decide, type StopReason } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { memoryMb } from '../../domain/server/size.ts'
import { checkSlug, type Slug, slugCandidates } from '../../domain/server/slug.ts'
import { createAccess } from '../access/persistence.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy, type UserActor } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { FUNNEL, noteOnce } from '../insight/record.ts'
import { loadOperation } from '../operations/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import type { PlayAddressing, RegionCatalog } from '../ports/platform.ts'
import { runsOf } from '../revisions/caps.ts'
import { draftOf } from '../revisions/service.ts'
import type { RuntimePlacement } from '../runtimes/service.ts'
import type { SetupService } from '../setups/service.ts'
import { newInviteCode } from './invites.ts'
import { type CreateServerRequest, draftNewServer } from './new-server.ts'
import {
  createRuntimeBinding,
  findByCreateKey,
  findServer,
  insertRevision,
  insertServer,
  loadRevision,
  lockServer,
  markActive,
  markDeleted,
  markUndeleted,
  purgeSooner,
  retireSlug,
  saveDeletionWarned,
  saveIdentity,
  setDesired,
  slugAvailable,
} from './persistence.ts'
import type { ServerTransitions } from './transitions.ts'

export type { CreateServerRequest } from './new-server.ts'

/** Slugs of deleted servers wait this long before anyone else may claim them (§19). */

/**
 * Decides intent and persists it. It never talks to a provider: work that touches
 * infrastructure is an operation, run by a worker after this transaction commits.
 */
export class MinecraftServerService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #transitions: ServerTransitions
  readonly #events: EventBus
  readonly #addressing: PlayAddressing
  readonly #regions: RegionCatalog
  readonly #placement: RuntimePlacement
  readonly #jobs: JobQueue
  readonly #builds: LoaderBuilds
  /** Setups resolve mods through the catalog, which is built after this service. */
  readonly #setups: () => SetupService

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    transitions: ServerTransitions
    events: EventBus
    addressing: PlayAddressing
    regions: RegionCatalog
    /** Where each new server goes: its runtime is decided, and recorded, as it is made. */
    placement: RuntimePlacement
    jobs: JobQueue
    loaderBuilds: LoaderBuilds
    setups: () => SetupService
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#transitions = deps.transitions
    this.#events = deps.events
    this.#addressing = deps.addressing
    this.#regions = deps.regions
    this.#placement = deps.placement
    this.#jobs = deps.jobs
    this.#builds = deps.loaderBuilds
    this.#setups = deps.setups
  }

  async createMinecraftServer(actor: UserActor, request: CreateServerRequest): Promise<MinecraftServer> {
    const existing = await findByCreateKey(this.#db, actor.userId, request.idempotencyKey)
    if (existing) return existing

    const draft = await draftNewServer(
      {
        db: this.#db,
        regions: this.#regions,
        builds: this.#builds,
        resolve: (from, by) => this.#setups().resolve(from, by),
      },
      actor,
      request,
    )
    const { regionKey, memoryTier, createdFrom, revision, world, plan, storageGb, origin } = draft

    const server = await this.#db.transaction(async (tx) => {
      // The server this one replaces makes way first, so it counts against nothing, and hands
      // over its address: whoever has it in their server list finds the new one there.
      const replaced =
        request.replaces === undefined ? null : await this.#makeWay(tx, actor, request.replaces)
      await this.#policy.require(tx, actor.userId, { kind: 'create_server', memoryTier })
      const slug = await this.#claimSlug(tx, request.name, replaced?.slug ?? request.slug)
      const created = await insertServer(
        tx,
        {
          ownerId: actor.userId,
          name: request.name,
          slug,
          inviteCode: newInviteCode(),
          regionKey,
          memoryTier,
          createIdempotencyKey: request.idempotencyKey,
          createdFrom,
          ...(request.temporary === true
            ? { expiresAt: new Date(Date.now() + TEMPORARY_HOURS * 3_600_000) }
            : {}),
        },
        { ...revision, createdBy: requestedBy(actor) },
        world,
      )
      const placed = await this.#placement.place(
        tx,
        {
          serverId: created.server.id,
          ownerId: actor.userId,
          plan,
          regionKey,
          memoryMb: memoryMb(memoryTier),
          storageGb,
        },
        requestedBy(actor),
      )
      await createRuntimeBinding(tx, created.server.id, placed.provider)
      await createAccess(tx, created.server.id)
      await this.#audit(tx, actor, 'server.created', created.server.id, {
        slug,
        gameVersion: revision.gameVersion,
        loader: revision.loader,
        from: createdFrom,
        ...origin,
      })
      await noteOnce(tx, {
        event: FUNNEL.serverCreated,
        subject: created.server.id,
        userId: actor.userId,
        properties: { from: createdFrom ?? 'direct', loader: revision.loader },
      })
      await this.#events.publish(tx, {
        type: 'server_changed',
        serverId: created.server.id,
        ownerId: actor.userId,
        status: created.server.lifecycle.status,
        version: created.server.version,
      })
      await this.#transitions.enqueue(tx, created.server, 'provision', {
        requestedBy: requestedBy(actor),
        idempotencyKey: 'provision',
      })
      return created.server
    })
    return server
  }

  /** The address a name would get, for the create flow to show before anything exists. */
  async suggestAddress(
    name: string,
    preferred?: string,
    serverId?: string,
  ): Promise<{ slug: string; joinAddress: string; available: boolean }> {
    const now = new Date()
    if (preferred !== undefined && preferred.length > 0) {
      const check = checkSlug(preferred)
      const available = check.ok && (await slugAvailable(this.#db, preferred, now, serverId))
      return { slug: preferred, joinAddress: this.#addressing.primary(preferred).hostname, available }
    }
    for (const candidate of slugCandidates(name || 'world', Math.random)) {
      if (await slugAvailable(this.#db, candidate, now))
        return { slug: candidate, joinAddress: this.#addressing.primary(candidate).hostname, available: true }
    }
    return { slug: '', joinAddress: '', available: false }
  }

  start(actor: Actor, serverId: string, requestId: string) {
    return this.#command(actor, serverId, { type: 'start' }, `start:${requestId}`)
  }

  stop(actor: Actor, serverId: string, requestId: string, reason: StopReason = 'user') {
    return this.#command(actor, serverId, { type: 'stop', reason }, `stop:${requestId}`, { reason })
  }

  /**
   * A stop the platform makes for its own upkeep (§4 `stopReason = maintenance`), by an admin:
   * the owner sees Blockly stopped it and may start it again; why is kept in the audit log.
   */
  async stopForMaintenance(actor: Actor, serverId: string, requestId: string, reason: string) {
    if (actor.kind !== 'admin') throw new NotFound('Server')
    const why = reason.trim()
    if (why.length === 0) throw new AppError('invalid_choice', 'Say why it stops.')
    return this.#command(
      actor,
      serverId,
      { type: 'stop', reason: 'maintenance' },
      `maintenance:${requestId}`,
      { reason: 'maintenance' },
      { action: 'server.maintenance_stop', data: { reason: why } },
    )
  }

  restart(actor: Actor, serverId: string, requestId: string) {
    return this.#command(actor, serverId, { type: 'restart' }, `restart:${requestId}`)
  }

  /** The failed work again, with what it was asked for: a restore its backup, a move its region. */
  async retry(actor: Actor, serverId: string, requestId: string) {
    const failure = (await findServer(this.#db, serverId))?.lifecycle.failure
    const failed = failure ? await loadOperation(this.#db, failure.operationId) : null
    return this.#command(actor, serverId, { type: 'retry' }, `retry:${requestId}`, failed?.input)
  }

  /**
   * Another region for the server (§9): its world is moved with it, and until the move succeeds
   * the server stays where it was. A running server comes back up there.
   */
  async relocate(
    actor: Actor,
    serverId: string,
    regionKey: string,
    requestId: string,
  ): Promise<MinecraftServer> {
    if (this.#regions.label(regionKey) === null)
      throw new AppError('invalid_choice', 'That location is not available.')
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.regionKey === regionKey) return server
      const { server: moving } = await this.#transitions.command(
        tx,
        server,
        { type: 'relocate' },
        {
          requestedBy: requestedBy(actor),
          idempotencyKey: `relocate:${requestId}`,
          input: { regionKey, running: server.lifecycle.status === 'running' },
        },
      )
      await this.#audit(tx, actor, 'server.relocate_requested', serverId, {
        from: server.regionKey,
        to: regionKey,
      })
      return moving
    })
  }

  /**
   * A move the platform makes (§9): to where the server's region maps now, after its provider
   * region was deprecated and the region remapped, or off a host that was lost, rebuilt from its
   * newest snapshot, or because an operator asked for it (a runtime that hosts servers on
   * machines it manages lets an operator move one off its machine). It stays in its region and
   * keeps its power state; a failed server ends stopped. Audited as the platform's.
   */
  /**
   * A move the platform makes: a region remapped, a lost host, an operator's drain, or a move to
   * another runtime an operator asked for (`to`, docs/runtimes.md).
   */
  async relocateForPlatform(
    serverId: string,
    reason: 'region' | 'host' | 'operator' | 'runtime',
    to?: string,
  ): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = await lockServer(tx, serverId)
      if (server === null) throw new NotFound('Server')
      const { server: moving } = await this.#transitions.command(
        tx,
        server,
        { type: 'relocate' },
        {
          requestedBy: requestedBy(PLATFORM),
          idempotencyKey: `relocate:${reason}:v${server.version}`,
          input: {
            regionKey: server.regionKey,
            running: server.lifecycle.status === 'running',
            ...(reason === 'host' ? { hostLost: true } : {}),
            ...(to === undefined ? {} : { toProvider: to }),
          },
        },
      )
      await this.#audit(tx, PLATFORM, 'server.relocation_scheduled', serverId, {
        reason,
        region: server.regionKey,
        ...(to === undefined ? {} : { to }),
      })
      return moving
    })
  }

  async deleteServer(actor: Actor, serverId: string, confirmName: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (confirmName.trim() !== server.name.trim())
        throw new AppError('confirmation_mismatch', 'Type the server’s name exactly to delete it.')
      const deleted = await this.#trash(tx, actor, server)
      await retireSlug(tx, deleted, new Date())
      await this.#audit(tx, actor, 'server.deleted', serverId, {})
      return deleted
    })
  }

  /** To the trash, for as long as the owner's plan keeps it there. */
  async #trash(tx: Tx, actor: Actor, server: MinecraftServer): Promise<MinecraftServer> {
    const { server: deleted } = await this.#transitions.command(
      tx,
      server,
      { type: 'delete' },
      // One decommission per deletion: a server deleted again after an undelete needs another.
      { requestedBy: requestedBy(actor), idempotencyKey: `decommission:v${server.version}` },
    )
    const now = new Date()
    const standing = await loadStanding(tx, server.ownerId)
    const retention = entitlementsFor(standing.plan, standing.limitOverrides).trashRetentionDays
    await markDeleted(tx, deleted, now, new Date(now.getTime() + retention * 86_400_000))
    // Deletion is an eligibility input (§5): the listing's read model follows it at once.
    await this.#jobs.enqueueEligibility([server.id], tx)
    return deleted
  }

  /**
   * A server whose first build failed, making way for the one its owner picked instead: to the
   * trash like any delete, without holding its address back, since the new server takes it. Only
   * one that never started: anything that ran has a world, and goes through delete.
   */
  async #makeWay(tx: Tx, actor: Actor, serverId: string): Promise<MinecraftServer> {
    const server = authorize(actor, await lockServer(tx, serverId))
    if (server.lifecycle.status !== 'failed' || server.lifecycle.failure?.during !== 'provisioning')
      throw new AppError('invalid_choice', 'Only a server that never started can be replaced this way.')
    const deleted = await this.#trash(tx, actor, server)
    await this.#audit(tx, actor, 'server.replaced', serverId, {})
    return deleted
  }

  /**
   * A server closed with its account: deleted without asking, and purged at
   * the next sweep rather than after the trash's retention. One already in the trash goes too.
   */
  async terminate(actor: Actor, serverId: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const now = new Date()
      if (server.lifecycle.status === 'purged') return server
      if (server.lifecycle.status === 'deleted') {
        // Already in the trash: it now goes at the next sweep instead of when its window ends.
        const sooner = await purgeSooner(tx, server, now)
        await this.#changed(tx, sooner)
        await this.#audit(tx, actor, 'server.terminated', serverId, {})
        return sooner
      }
      const { server: deleted } = await this.#transitions.command(
        tx,
        server,
        { type: 'delete' },
        { requestedBy: requestedBy(actor), idempotencyKey: `decommission:v${server.version}` },
      )
      await markDeleted(tx, deleted, now, now)
      await retireSlug(tx, deleted, now)
      await this.#audit(tx, actor, 'server.terminated', serverId, {})
      await this.#jobs.enqueueEligibility([serverId], tx)
      return deleted
    })
  }

  /**
   * What the owner calls their world, says about it, and picks for its picture. None of it
   * restarts anything: the name is Blockly's, and the icon reaches the game at its next start.
   * A server list message still in Blockly's words quotes the old name, so it follows the new one,
   * as a revision of its own that also arrives at the next start; one the owner wrote stays.
   */
  async saveIdentity(
    actor: Actor,
    serverId: string,
    identity: {
      name?: string
      description?: string
      icon?: string | null
      tags?: readonly string[]
    },
  ): Promise<MinecraftServer> {
    const name = identity.name?.trim()
    if (name !== undefined && (name.length === 0 || name.length > 40))
      throw new AppError('invalid_name', 'A name is 1 to 40 characters.')
    const description = identity.description?.trim()
    if (description !== undefined && description.length > 1000)
      throw new AppError('invalid_choice', 'A description is up to 1000 characters.')
    const icons: readonly string[] = SERVER_ICONS
    if (identity.icon !== undefined && identity.icon !== null && !icons.includes(identity.icon))
      throw new AppError('invalid_choice', 'Pick one of Cubepals’ icons.')
    const tags = identity.tags === undefined ? undefined : [...new Set(identity.tags)]
    const known: readonly string[] = SERVER_TAGS
    if (tags !== undefined && (tags.length > 5 || tags.some((tag) => !known.includes(tag))))
      throw new AppError('invalid_choice', `Pick up to 5 tags from: ${SERVER_TAGS.join(', ')}.`)

    const saved = await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const change = {
        ...(name === undefined || name === server.name ? {} : { name }),
        ...(description === undefined || description === server.description ? {} : { description }),
        ...(identity.icon === undefined || identity.icon === server.icon ? {} : { icon: identity.icon }),
        ...(tags === undefined || tags.join() === server.tags.join() ? {} : { tags }),
      }
      if (Object.keys(change).length === 0) return server
      let next = await saveIdentity(tx, server, change)
      const desired = await loadRevision(tx, server.desiredRevisionId)
      const motd = welcome(next.name)
      const redraft = desired.settings.motd === welcome(server.name) && desired.settings.motd !== motd
      if (redraft) {
        const draft: RevisionDraft = {
          ...draftOf(desired),
          settings: { ...desired.settings, motd },
          reason: 'settings_changed',
          basedOnRevisionId: desired.id,
        }
        const revision = await insertRevision(tx, server.id, draft, requestedBy(actor))
        next = await setDesired(tx, next, { revisionId: revision.id })
      }
      await this.#changed(tx, next)
      await this.#audit(tx, actor, 'server.identity_changed', serverId, {
        ...change,
        ...(redraft ? { motd } : {}),
      })
      return next
    })
    // What a server is called and says is what the directory shows, so its listing follows it.
    if (saved.version !== undefined) await this.#jobs.enqueueEligibility([serverId])
    return saved
  }

  /**
   * Keeping a server that was made for a while. Blockly said when it would delete it; this is
   * the way back, and after it the server is like any other.
   */
  async keep(actor: Actor, serverId: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.expiresAt === null) return server
      const next = await saveIdentity(tx, server, { expiresAt: null })
      await this.#changed(tx, next)
      await this.#audit(tx, actor, 'server.kept', serverId, {})
      return next
    })
  }

  /**
   * Keeping a world its plan would delete for going unplayed: the same as playing on
   * it, as far as that clock goes. It stays asleep, or resting, as it was.
   */
  async keepWorld(actor: Actor, serverId: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      await markActive(tx, server.id, new Date())
      await saveDeletionWarned(tx, server.id, null)
      await this.#audit(tx, actor, 'server.kept_unplayed', serverId, {})
      return server
    })
  }

  /** A new invite link. The old one stops working, which is the point. */
  async resetInvite(actor: Actor, serverId: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const next = await saveIdentity(tx, server, { inviteCode: newInviteCode() })
      await this.#audit(tx, actor, 'server.invite_reset', serverId, {})
      return next
    })
  }

  /**
   * A new address. The old one is quarantined like a deleted server's (§19), so nobody else can
   * take it and receive this server's players; this server may take it back. Routes follow on
   * the edge's next poll, and nothing restarts.
   */
  async changeAddress(actor: Actor, serverId: string, slug: string): Promise<MinecraftServer> {
    const check = checkSlug(slug)
    if (!check.ok)
      throw new AppError('slug_invalid', 'Addresses use 3–40 lowercase letters, numbers and dashes.')
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.slug === check.slug) return server
      if (server.lifecycle.status === 'deleted' || server.lifecycle.status === 'purged')
        throw new AppError('invalid_transition', 'A deleted server keeps its address until it is restored.')
      const now = new Date()
      if (!(await slugAvailable(tx, check.slug, now, server.id)))
        throw new AppError('slug_taken', 'That address is taken — try adding a word.')
      await retireSlug(tx, server, now)
      await tx.delete(schema.retiredSlugs).where(eq(schema.retiredSlugs.slug, check.slug))
      const moved = await saveIdentity(tx, server, { slug: check.slug })
      await this.#changed(tx, moved)
      await this.#audit(tx, actor, 'server.address_changed', serverId, { from: server.slug, to: check.slug })
      return moved
    })
  }

  async undeleteServer(actor: Actor, serverId: string): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.purgeAfter === null || server.purgeAfter <= new Date())
        throw new AppError('invalid_transition', 'This server can no longer be restored.')
      if (actor.kind === 'user') await this.#policy.require(tx, server.ownerId, { kind: 'undelete_server' })
      const { server: restored } = await this.#transitions.command(
        tx,
        server,
        { type: 'undelete', stored: server.storedAt !== null },
        {
          requestedBy: requestedBy(actor),
          idempotencyKey: `undelete:${crypto.randomUUID()}`,
        },
      )
      // Its address went to the server that replaced it: back from the trash, it takes a new one,
      // before it is live again beside that one.
      const back = (await slugAvailable(tx, restored.slug, new Date(), restored.id))
        ? restored
        : await saveIdentity(tx, restored, { slug: await this.#claimSlug(tx, restored.name, undefined) })
      await markUndeleted(tx, back)
      await tx.delete(schema.retiredSlugs).where(eq(schema.retiredSlugs.slug, back.slug))
      await this.#audit(
        tx,
        actor,
        'server.undeleted',
        serverId,
        back === restored ? {} : { readdressed: back.slug },
      )
      await this.#jobs.enqueueEligibility([serverId], tx)
      return back
    })
  }

  async #command(
    actor: Actor,
    serverId: string,
    command: Command,
    idempotencyKey: string,
    input?: Record<string, unknown>,
    audit?: { action: string; data: Record<string, unknown> },
  ) {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const decision = decide(server.lifecycle, command)
      // What the server would boot, for the checks below: the plan must run it.
      const runs = async () => runsOf(server.memoryTier, await loadRevision(tx, server.desiredRevisionId))
      // Only work that brings compute up is policy-checked; stopping is always allowed.
      if (decision.kind === 'accept' && (decision.operation === 'start' || decision.operation === 'unstore'))
        await this.#policy.require(tx, server.ownerId, { kind: 'start_server', runs: await runs() })
      if (decision.kind === 'accept' && decision.operation === 'restart')
        await this.#policy.require(tx, server.ownerId, { kind: 'restart_server', runs: await runs() })
      if (decision.kind === 'accept' && decision.operation === 'provision')
        await this.#policy.require(tx, server.ownerId, { kind: 'continue_provisioning' })
      // Bringing a failed server back up is a start: its running slot went with the failure.
      const bootsFromFailure =
        decision.kind === 'accept' &&
        server.lifecycle.status === 'failed' &&
        (decision.operation === 'apply' ||
          decision.operation === 'restore' ||
          decision.operation === 'relocate') &&
        input?.running !== false
      if (bootsFromFailure)
        await this.#policy.require(tx, server.ownerId, { kind: 'start_server', runs: await runs() })
      const request = bootsFromFailure ? { ...input, fromFailure: true } : input
      // Its owner starting it is as good as playing: a world they just woke doesn't rest under them.
      const boots =
        decision.kind === 'accept' &&
        (decision.operation === 'start' ||
          decision.operation === 'restart' ||
          decision.operation === 'unstore')
      if (boots && actor.kind === 'user') await markActive(tx, server.id, new Date())
      const result = await this.#transitions.command(tx, server, command, {
        requestedBy: requestedBy(actor),
        idempotencyKey,
        ...(request ? { input: request } : {}),
      })
      // Only what was done is audited: a stop of a stopped server did nothing.
      if (audit && result.operation !== null) await this.#audit(tx, actor, audit.action, serverId, audit.data)
      return result.server
    })
  }

  async #claimSlug(tx: Tx, name: string, preferred: string | undefined): Promise<Slug> {
    const now = new Date()
    if (preferred !== undefined) {
      const check = checkSlug(preferred)
      if (!check.ok)
        throw new AppError('slug_invalid', 'Addresses use 3–40 lowercase letters, numbers and dashes.')
      if (!(await slugAvailable(tx, preferred, now)))
        throw new AppError('slug_taken', 'That address is taken — try adding a word.')
      return check.slug
    }
    for (const candidate of slugCandidates(name, Math.random)) {
      const check = checkSlug(candidate)
      if (check.ok && (await slugAvailable(tx, candidate, now))) return check.slug
    }
    throw new AppError('slug_taken', 'We could not find a free address for that name. Pick one yourself.')
  }

  async #changed(tx: Tx, server: MinecraftServer) {
    await this.#events.publish(tx, {
      type: 'server_changed',
      serverId: server.id,
      ownerId: server.ownerId,
      status: server.lifecycle.status,
      version: server.version,
    })
  }

  async #audit(tx: Tx, actor: Actor, action: string, serverId: string, data: Record<string, unknown>) {
    await tx
      .insert(schema.auditLog)
      .values({ actor: requestedBy(actor), action, subjectType: 'server', subjectId: serverId, data })
  }
}

/** What the platform does on its own, found by reconciling what the provider reports. */
const PLATFORM: Actor = { kind: 'system', reason: 'reconcile' }

/**
 * How long a server made for a while lasts. A day covers the thing people ask for — an evening
 * with friends, a modpack someone wants to try — and it is one number rather than a question
 * with options. Keeping it is one press, and Blockly says the exact time from the start.
 */
const TEMPORARY_HOURS = 24
