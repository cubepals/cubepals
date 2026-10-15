// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { BLOCKLY_ICON } from '@blockly/contracts'
import type { EdgeRoutes, SessionEvent, WakeResult } from '@blockly/contracts/edge'
import { motdForGame } from '@blockly/contracts/server-list'
import type { AppliedConfigJson, Db } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { welcome } from '../../domain/revision/revision.ts'
import { ROUTABLE, type ServerStatus } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { outForToday, playToday } from '../accounts/play-today.ts'
import { playTotal } from '../accounts/play-total.ts'
import type { ArtifactLinks } from '../artifacts/links.ts'
import { AppError, type AppErrorCode } from '../errors.ts'
import { failedWaking, openOfKinds } from '../operations/persistence.ts'
import type { IdleDecision, Schedules } from '../operations/schedules.ts'
import type { EventBus } from '../ports/events.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import type { Endpoint } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import {
  findLiveBySlug,
  findRuntime,
  findServer,
  heldByDeleted,
  listBindings,
  listLive,
  motdsOf,
} from '../servers/persistence.ts'
import type { MinecraftServerService } from '../servers/service.ts'
import { presenceFor, recordDomainJoin, recordEdgePresence, wakesInLastHour } from '../servers/usage.ts'
import type { ServerWaiter } from '../servers/waiter.ts'
import { tuning } from '../tuning.ts'
import { databaseNow, markListed, seen } from './routed.ts'

/**
 * The application side of the edge protocol. It resolves hostnames and destinations; the edge
 * only forwards, and never learns what a slug or a play domain is.
 */
/** Between two runs of a server: whether it comes back by itself depends on the work under way. */
const BETWEEN_RUNS: readonly ServerStatus[] = ['stopping', 'starting', 'restoring', 'relocating']

/**
 * Why a start the edge asked for was refused, by the error that refused it; any other error is
 * `unknown`. Each reason is one of the edge's messages, `TURNED_AWAY` in apps/edge/agent.ts.
 */
const REFUSED: Partial<Record<AppErrorCode, Extract<WakeResult, { outcome: 'denied' }>['reason']>> = {
  account_suspended: 'suspended',
  restricted: 'suspended',
  platform_paused: 'paused',
  limit_reached: 'quota',
  not_entitled: 'quota',
  payment_due: 'quota',
}

/** On its way to a rest, to sleep, or onto another host: a join waits for it, then wakes it. */
const MOVING_ON: ReadonlySet<ServerStatus> = new Set(['storing', 'stopping', 'relocating'])

/** A route's word that its server reads a PROXY header, where the run it is in does. */
const headerRead = (applied: AppliedConfigJson | null | undefined): { proxyProtocol?: true } =>
  applied?.proxyProtocol ? { proxyProtocol: true } : {}

export class EdgeService {
  readonly #db: Db
  readonly #addressing: PlayAddressing
  readonly #runtime: Runtimes
  readonly #service: MinecraftServerService
  readonly #waiter: ServerWaiter
  readonly #schedules: Schedules
  readonly #events: EventBus
  readonly #links: ArtifactLinks
  readonly #wakeWaitMs: number

  constructor(deps: {
    db: Db
    addressing: PlayAddressing
    runtime: Runtimes
    service: MinecraftServerService
    waiter: ServerWaiter
    schedules: Schedules
    events: EventBus
    links: ArtifactLinks
    wakeWaitMs: number
  }) {
    this.#db = deps.db
    this.#addressing = deps.addressing
    this.#runtime = deps.runtime
    this.#service = deps.service
    this.#waiter = deps.waiter
    this.#schedules = deps.schedules
    this.#events = deps.events
    this.#links = deps.links
    this.#wakeWaitMs = deps.wakeWaitMs
  }

  /** Every hostname that should route, with where the edge sends it. */
  async routes(): Promise<EdgeRoutes> {
    return (await this.listed()).routes
  }

  /**
   * The routes, and the database's time as their read began: an edge that holds this very list
   * holds the route of every server named running before then (`routed.ts`). The first list to
   * name a server running says so on it; nothing else is written.
   */
  async listed(): Promise<{ routes: EdgeRoutes; from: Date }> {
    const from = await databaseNow(this.#db)
    const bindings = new Map(
      (await listBindings(this.#db, this.#runtime.providers)).map((b) => [b.serverId, b]),
    )
    const live = await listLive(this.#db)
    const restarting = await this.#restarting(live)
    const out = await outForToday(this.#db, new Date())
    const asleep = live.filter((s) => s.lifecycle.status !== 'running' && !restarting.has(s.id))
    const motds = await motdsOf(
      this.#db,
      asleep.map((s) => s.desiredRevisionId),
    )
    const routes: EdgeRoutes['routes'] = []
    for (const server of live) {
      const binding = bindings.get(server.id)
      const handle = binding?.handle
      const { status } = server.lifecycle
      const state = status === 'running' ? null : restarting.has(server.id) ? 'restarting' : 'asleep'
      // A running server being restored is routed only so its players are told it is restarting:
      // the edge dials nothing while it is.
      if (!handle || !(ROUTABLE.includes(status) || state === 'restarting')) continue
      // An address the provider may give to other compute once this server stops is only its own
      // while it runs: until then the route names nothing at all.
      const destination =
        this.#runtime.stableEndpoint(handle) || state === null
          ? destinationOf(this.#runtime.endpoint(handle, PORT_NAMES.game, 'edge'))
          : NOWHERE
      for (const address of this.#addressing.all(server.slug)) {
        routes.push({
          hostname: address.hostname,
          destination,
          ...noticeOf(state, out.get(server.id)),
          ...this.#identityOf(server, state, motds),
          ...headerRead(binding?.applied),
        })
      }
    }
    routes.sort((a, b) => a.hostname.localeCompare(b.hostname))
    // Each running server with a handle is routed to, above.
    await markListed(
      this.#db,
      live.filter((s) => s.lifecycle.status === 'running' && bindings.get(s.id)?.handle).map((s) => s.id),
    )
    return { routes: { routes }, from }
  }

  /**
   * Edge `edgeId` asked for its routes, holding the list read from `syncedTo` on, or a list it
   * would not be handed now (null).
   */
  async seen(edgeId: string, syncedTo: Date | null): Promise<void> {
    await seen(this.#db, this.#events, edgeId, syncedTo)
  }

  /**
   * What the server list shows of an asleep server, where its owner made it their own: the message
   * it starts with next, and its picture. Blockly's welcome and its default picture are left out,
   * so the edge says only that it sleeps.
   */
  #identityOf(
    server: MinecraftServer,
    state: 'asleep' | 'restarting' | null,
    motds: ReadonlyMap<string, string>,
  ): Pick<EdgeRoutes['routes'][number], 'motd' | 'icon'> {
    if (state !== 'asleep') return {}
    const motd = motds.get(server.desiredRevisionId)
    const icon =
      server.ownIcon !== null
        ? this.#links.ownIcon(server.id, server.ownIcon)
        : server.icon !== null && server.icon !== BLOCKLY_ICON
          ? this.#links.icon(server.icon)
          : undefined
    return {
      ...(motd === undefined || motd === welcome(server.name) ? {} : { motd: motdForGame(motd) }),
      ...(icon === undefined ? {} : { icon }),
    }
  }

  /**
   * Someone is joining a server that is not running: start it through the same checks as the UI.
   * Whatever it waits for, a restart, a rest or the start itself, comes out of one wait of
   * `wakeWaitMs`, which the edge outlasts: it gives up on its request after 30 s. `retries`: a
   * start that failed for good in waking is tried again, which only an edge that words such a
   * failure asks for; an older one, told the server still starts, would ask again every few
   * seconds, and start it again each time.
   */
  async wake(hostname: string, retries = true): Promise<WakeResult> {
    const deadline = Date.now() + this.#wakeWaitMs
    const left = () => Math.max(0, deadline - Date.now())
    const slug = this.#addressing.slugFor(hostname)
    const server = slug === null ? null : await findLiveBySlug(this.#db, slug)
    if (server === null) {
      // A server in the trash still holds its address, so no other server takes it, but has no
      // route: only an edge that hasn't polled since it was deleted asks, and is refused as deleted.
      const deleted = slug !== null && (await heldByDeleted(this.#db, slug))
      return { outcome: 'denied', reason: deleted ? 'deleted' : 'unknown' }
    }

    const settled = await this.#settled(server, left)
    if (typeof settled === 'object') return settled

    if (settled !== 'running') {
      // Nothing about a connection proves who sent it, so wakes from the edge are capped an hour
      // (`AbuseLimits.wakesPerHour`); with the probation on each (WAKE_PROBATION_MS), that bounds
      // what a flood of connections can wake.
      if ((await wakesInLastHour(this.#db, server.id, new Date())) >= tuning().abuse.wakesPerHour)
        return { outcome: 'denied', reason: 'quota' }
      const unstarted = await this.#start(server, left, retries)
      if (unstarted !== null) return unstarted
    }

    const binding = await findRuntime(this.#db, server.id, this.#runtime.providers)
    if (!binding?.handle) return { outcome: 'starting' }
    return {
      outcome: 'ready',
      destination: destinationOf(this.#runtime.endpoint(binding.handle, PORT_NAMES.game, 'edge')),
      ...headerRead(binding.applied),
    }
  }

  /**
   * The status `server` comes to rest at before a join goes on, or what the join is told when it
   * hasn't by the time `left` runs out.
   */
  async #settled(server: MinecraftServer, left: () => number): Promise<ServerStatus | WakeResult> {
    // On its way back from a restart: the join waits for it, and never starts it a second time.
    // Only one that came back stopped goes on to be woken, through the same checks as always.
    if ((await this.#restarting([server])).has(server.id)) {
      const back = await this.#waiter.waitFor(server.id, ['running', 'stopped', 'failed', 'stored'], left())
      return back ?? { outcome: 'restarting' }
    }
    // Being put to rest or to sleep right now, which takes seconds (a sleep writes the server's
    // memory out), or rebuilt on another host its wake asked for: the join waits for that to
    // finish, then wakes it, rather than being turned away for arriving at the wrong moment.
    // Whatever it came to, the start goes on.
    if (MOVING_ON.has(server.lifecycle.status)) {
      const rested = await this.#waiter.waitFor(server.id, ['stored', 'stopped', 'running', 'failed'], left())
      return rested === null ? { outcome: 'starting' } : server.lifecycle.status
    }
    return server.lifecycle.status
  }

  /**
   * Starts the server through the same checks as the UI, and waits for it to run: null once it
   * does, or what the join is told when it was refused or hasn't by the time `left` runs out.
   */
  async #start(server: MinecraftServer, left: () => number, retries: boolean): Promise<WakeResult | null> {
    const actor = { kind: 'system', reason: 'wake' } as const
    const failed = await this.#failed(server)
    const retrying = retries && failed === 'waking'
    if (failed !== null && !retrying)
      return { outcome: 'denied', reason: failed === 'waking' ? 'failed' : 'broken' }
    try {
      if (retrying) await this.#service.retry(actor, server.id, crypto.randomUUID())
      else await this.#service.start(actor, server.id, crypto.randomUUID())
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      // A join at another edge asked first, and the start it asked for runs: this one waits on it.
      const starting = (await findServer(this.#db, server.id))?.lifecycle.status === 'starting'
      if (error.code !== 'invalid_transition' || !starting) return this.#refused(server, error)
    }
    const status = await this.#waiter.waitFor(server.id, ['running', 'failed', 'stopped', 'stored'], left())
    if (status === 'failed') return { outcome: 'denied', reason: 'failed' }
    return status === 'running' ? null : { outcome: 'starting' }
  }

  /**
   * How the server's last start failed for good, where it did: `waking`, in waking it (a resume
   * that hung, a host that couldn't run it), which the next join tries again within the hourly
   * cap; `running`, over what the server runs (a broken mod, a crash), which would only fail again
   * and is its owner's. Read now: what the join waited through may have ended in one.
   */
  async #failed(server: MinecraftServer): Promise<'waking' | 'running' | null> {
    const { lifecycle } = (await findServer(this.#db, server.id)) ?? server
    if (lifecycle.status !== 'failed') return null
    const { failure } = lifecycle
    const waking = failure?.during === 'starting' && (await failedWaking(this.#db, failure.operationId))
    return waking ? 'waking' : 'running'
  }

  /** What a join is told when its start was refused. */
  async #refused(server: MinecraftServer, error: AppError): Promise<WakeResult> {
    const reason = REFUSED[error.code] ?? 'unknown'
    const backAt = error.code === 'limit_reached' ? await this.#backAt(server) : null
    return { outcome: 'denied', reason, ...(backAt === null ? {} : { backAt: backAt.toISOString() }) }
  }

  /**
   * When the owner's play is back, where a wake was refused because today's is used; else null,
   * and null once the plan's play in all is used too: midnight brings none of that back.
   */
  async #backAt(server: MinecraftServer): Promise<Date | null> {
    const standing = await loadStanding(this.#db, server.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const now = new Date()
    const total = await playTotal(this.#db, standing, plan, now)
    if (total !== null && total.left <= 0) return null
    const today = await playToday(this.#db, standing, plan, now)
    return today !== null && today.left <= 0 ? today.backAt : null
  }

  /**
   * Which of `servers` are on their way back from a restart Blockly began: a restart, any apply
   * (settings, versions, packs, worlds, a rollback), or a restore or a move of a running server.
   */
  async #restarting(servers: readonly MinecraftServer[]): Promise<Set<string>> {
    const restarting = new Set(servers.filter((s) => s.lifecycle.status === 'updating').map((s) => s.id))
    const between = servers.filter((s) => BETWEEN_RUNS.includes(s.lifecycle.status)).map((s) => s.id)
    for (const operation of await openOfKinds(this.#db, between, ['restart', 'restore', 'relocate'])) {
      // A restore or a move comes back running only when it began on a running server.
      if (operation.kind === 'restart' || operation.input.running === true) restarting.add(operation.serverId)
    }
    return restarting
  }

  /** The edge saw no players for a while. Only the idle policy decides whether to stop. */
  async idleHint(hostname: string): Promise<IdleDecision | 'not_running' | 'players_online'> {
    const slug = this.#addressing.slugFor(hostname)
    const server = slug === null ? null : await findLiveBySlug(this.#db, slug)
    if (server?.lifecycle.status !== 'running') return 'not_running'
    const online = await presenceFor(this.#db, [server.id])
    if ((online.get(server.id)?.length ?? 0) > 0) return 'players_online'
    return this.#schedules.evaluateIdle(server)
  }

  /** A connect or disconnect the edge saw. The identity is claimed by the client: display only. */
  async recordSession(event: SessionEvent): Promise<void> {
    if (!event.player) return
    const slug = this.#addressing.slugFor(event.hostname)
    const server = slug === null ? null : await findLiveBySlug(this.#db, slug)
    if (server === null) return
    const uuid = normalizeUuid(event.player.uuid)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) return
    const player = { uuid, name: event.player.name }
    await this.#db.transaction(async (tx) => {
      await recordEdgePresence(tx, server.id, player, event.event, new Date(event.at))
      // Which address people join through: an alias left from a domain move can go once it's quiet.
      const domain = this.#addressing.domainFor(event.hostname)
      if (event.event === 'connect' && domain !== null) await recordDomainJoin(tx, domain, new Date(event.at))
      const online = (await presenceFor(tx, [server.id])).get(server.id) ?? []
      await this.#events.publish(tx, {
        type: 'presence',
        serverId: server.id,
        ownerId: server.ownerId,
        online: online.length,
      })
    })
  }
}

/**
 * What a route says about a server that isn't running: why, and for one asleep because its owner's
 * day of play ran out, when it is back.
 */
function noticeOf(
  state: 'asleep' | 'restarting' | null,
  backAt: Date | undefined,
): Pick<EdgeRoutes['routes'][number], 'state' | 'backAt'> {
  if (state === null) return {}
  return state === 'asleep' && backAt !== undefined ? { state, backAt: backAt.toISOString() } : { state }
}

/**
 * A destination the edge can't dial: nothing listens on port 0, so a status ping fails at once and
 * gets the asleep message, and a join asks for a wake.
 */
export const NOWHERE = '0.0.0.0:0'

/** Where the edge dials: `host:port`, with an IPv6 address in brackets, as dialers read it. */
export const destinationOf = (endpoint: Endpoint): string =>
  endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`
