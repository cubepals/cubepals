import type { EdgeRoutes, SessionEvent, WakeResult } from '@blockly/contracts/edge'
import type { Db } from '@blockly/db'
import { ROUTABLE, type ServerStatus } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { AppError } from '../errors.ts'
import { openOfKinds } from '../operations/persistence.ts'
import type { IdleDecision, Schedules } from '../operations/schedules.ts'
import type { EventBus } from '../ports/events.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import type { Endpoint } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { findLiveBySlug, heldByDeleted, listBindings, listLive } from '../servers/persistence.ts'
import type { MinecraftServerService } from '../servers/service.ts'
import { presenceFor, recordDomainJoin, recordEdgePresence, wakesInLastHour } from '../servers/usage.ts'
import type { ServerWaiter } from '../servers/waiter.ts'

/**
 * The application side of the edge protocol. It resolves hostnames and destinations; the edge
 * only forwards, and never learns what a slug or a play domain is.
 */
/**
 * How often a connection may wake one server in an hour. Well past what a group of friends
 * joining, drifting off and coming back would ever need, and far below what a flood wants: with
 * the five-minute probation on each one (WAKE_PROBATION_MS), this bounds an abusive hostname's
 * whole cost.
 */
const WAKES_PER_HOUR = 12

/** Between two runs of a server: whether it comes back by itself depends on the work under way. */
const BETWEEN_RUNS: readonly ServerStatus[] = ['stopping', 'starting', 'restoring', 'relocating']

export class EdgeService {
  readonly #db: Db
  readonly #addressing: PlayAddressing
  readonly #runtime: Runtimes
  readonly #service: MinecraftServerService
  readonly #waiter: ServerWaiter
  readonly #schedules: Schedules
  readonly #events: EventBus
  readonly #wakeWaitMs: number

  constructor(deps: {
    db: Db
    addressing: PlayAddressing
    runtime: Runtimes
    service: MinecraftServerService
    waiter: ServerWaiter
    schedules: Schedules
    events: EventBus
    wakeWaitMs: number
  }) {
    this.#db = deps.db
    this.#addressing = deps.addressing
    this.#runtime = deps.runtime
    this.#service = deps.service
    this.#waiter = deps.waiter
    this.#schedules = deps.schedules
    this.#events = deps.events
    this.#wakeWaitMs = deps.wakeWaitMs
  }

  /** Every hostname that should route, with where the edge sends it. Nothing is persisted. */
  async routes(): Promise<EdgeRoutes> {
    const handles = new Map(
      (await listBindings(this.#db, this.#runtime.providers)).map((b) => [b.serverId, b.handle]),
    )
    const live = await listLive(this.#db)
    const restarting = await this.#restarting(live)
    const routes: EdgeRoutes['routes'] = []
    for (const server of live) {
      const handle = handles.get(server.id)
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
        routes.push({ hostname: address.hostname, destination, ...(state === null ? {} : { state }) })
      }
    }
    routes.sort((a, b) => a.hostname.localeCompare(b.hostname))
    return { routes }
  }

  /**
   * Someone is joining a server that is not running: start it through the same checks as the UI.
   * Whatever it waits for, a restart, a rest or the start itself, comes out of one wait of
   * `wakeWaitMs`, which the edge outlasts: it gives up on its request after 30 s.
   */
  async wake(hostname: string): Promise<WakeResult> {
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

    const destination = async () => {
      const handles = new Map(
        (await listBindings(this.#db, this.#runtime.providers)).map((b) => [b.serverId, b.handle]),
      )
      const handle = handles.get(server.id)
      if (!handle) return null
      return destinationOf(this.#runtime.endpoint(handle, PORT_NAMES.game, 'edge'))
    }

    let status = server.lifecycle.status
    // On its way back from a restart: the join waits for it, and never starts it a second time.
    // Only one that came back stopped goes on to be woken, through the same checks as always.
    if ((await this.#restarting([server])).has(server.id)) {
      const back = await this.#waiter.waitFor(server.id, ['running', 'stopped', 'failed', 'stored'], left())
      if (back === null) return { outcome: 'restarting' }
      status = back
    }

    // Being put to rest right now, which takes seconds: the join waits for that to finish, then
    // wakes it, rather than being turned away for arriving at the wrong moment.
    if (status === 'storing') {
      const rested = await this.#waiter.waitFor(server.id, ['stored', 'stopped', 'running'], left())
      if (rested === null) return { outcome: 'starting' }
    }

    if (status !== 'running') {
      // Waking costs the owner money, and nothing about a connection proves who sent it. A server
      // woken this often in one hour has already had every chance to be joined for real.
      if ((await wakesInLastHour(this.#db, server.id, new Date())) >= WAKES_PER_HOUR)
        return { outcome: 'denied', reason: 'quota' }
      try {
        await this.#service.start({ kind: 'system', reason: 'wake' }, server.id, crypto.randomUUID())
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        const reason =
          error.code === 'account_suspended' || error.code === 'restricted'
            ? 'suspended'
            : error.code === 'platform_paused'
              ? 'paused'
              : error.code === 'limit_reached' ||
                  error.code === 'not_entitled' ||
                  error.code === 'payment_due'
                ? 'quota'
                : 'unknown'
        return { outcome: 'denied', reason }
      }
      const status = await this.#waiter.waitFor(server.id, ['running', 'failed', 'stopped', 'stored'], left())
      if (status !== 'running') return { outcome: 'starting' }
    }
    const to = await destination()
    return to === null ? { outcome: 'starting' } : { outcome: 'ready', destination: to }
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
 * A destination the edge can't dial: nothing listens on port 0, so a status ping fails at once and
 * gets the asleep message, and a join asks for a wake.
 */
export const NOWHERE = '0.0.0.0:0'

/** Where the edge dials: `host:port`, with an IPv6 address in brackets, as dialers read it. */
export const destinationOf = (endpoint: Endpoint): string =>
  endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`
