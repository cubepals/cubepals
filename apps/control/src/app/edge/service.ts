// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { BLOCKLY_ICON } from '@blockly/contracts'
import { HOUR_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { EdgeRoutes, PingWakeResult, SessionEvent, WakeResult } from '@blockly/contracts/edge'
import { motdForGame } from '@blockly/contracts/server-list'
import type { AppliedConfigJson, Db } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { welcome } from '../../domain/revision/revision.ts'
import { keptAt, keptFor } from '../../domain/server/kept-addresses.ts'
import { type OperationKind, ROUTABLE, type ServerStatus } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { clientRange, RELEASES } from '../../minecraft/clients.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { COMPAT } from '../../minecraft/mods.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { outOf, playToday } from '../accounts/play-today.ts'
import { playTotal, trialOver } from '../accounts/play-total.ts'
import type { ArtifactLinks } from '../artifacts/links.ts'
import { AppError, type AppErrorCode } from '../errors.ts'
import {
  databaseNow,
  failedWaking,
  loadOperation,
  openOfKinds,
  wakeStarts,
} from '../operations/persistence.ts'
import type { IdleDecision, Schedules } from '../operations/schedules.ts'
import { wakeAnswered } from '../platform/telemetry.ts'
import type { ChangeSignal } from '../ports/changes.ts'
import type { EventBus } from '../ports/events.ts'
import type { PlayAddress, PlayAddressing } from '../ports/platform.ts'
import type { Endpoint, RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { SecretKeyring } from '../secrets.ts'
import { findLiveBySlug, findRuntime, findServer, heldByDeleted } from '../servers/persistence.ts'
import type { MinecraftServerService } from '../servers/service.ts'
import {
  playedHere,
  presenceFor,
  recordDomainJoin,
  recordEdgePresence,
  unjoinedWakes,
} from '../servers/usage.ts'
import type { ServerWaiter } from '../servers/waiter.ts'
import { tuning } from '../tuning.ts'
import { type Fingerprint, fingerprint, type RouteInputs, type RouteServer, readInputs } from './inputs.ts'
import { forgetAddresses, joinEnded } from './known-addresses.ts'
import { pingWake } from './ping-wake.ts'
import { EDGE_SAID_EVERY_MS, forgetQuietEdges, markListed, sawEdge, seen } from './routed.ts'
import { restingFor, turnedAway } from './turned-away.ts'

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

/**
 * The longest the route inputs' fingerprint goes unread while the database says none of them
 * moved: a net for a write it never announced. How soon a change reaches the edges is the
 * announcement's doing, not this.
 */
const FINGERPRINT_BACKSTOP_MS = 30 * SECOND_MS

/** The work a start waits behind that a join is told of, by kind, as the edge words it. */
const BEHIND: ReadonlyMap<
  OperationKind,
  NonNullable<Extract<WakeResult, { outcome: 'starting' }>['behind']>
> = new Map([
  ['store', 'rest'],
  ['stop', 'stop'],
  ['backup', 'backup'],
])

/** On its way to a rest, to sleep, or onto another host: a join waits for it, then wakes it. */
const MOVING_ON: ReadonlySet<ServerStatus> = new Set(['storing', 'stopping', 'relocating'])

/** A start that found its server had moved on to other work since the join read it. */
const MOVED_ON = Symbol('moved on')

/** Who a start a join asked for is requested by. */
const WAKE = { kind: 'system', reason: 'wake' } as const

/** What a join that starts nothing is told: the server sleeps. */
const LEFT_ASLEEP: WakeResult = { outcome: 'asleep' }

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
  readonly #keyring: SecretKeyring
  readonly #wakeWaitMs: number
  /**
   * The route inputs last read and the fingerprint they were read under; the change mark taken
   * just before (null where none could be heard); when the read ended, by this clock; and how far
   * the database's clock was ahead of this one then.
   */
  #read: {
    inputs: RouteInputs
    print: Fingerprint
    mark: number | null
    at: number
    offset: number
  } | null = null
  /** Word that the route inputs moved; without it, the fingerprint is read on every ask. */
  readonly #changes: ChangeSignal | null
  /** When each edge's word was last written, by this process. */
  readonly #saidAt = new Map<string, number>()
  /** When each edge's agent last said it started, to write a restart at once. */
  readonly #startedOf = new Map<string, number>()
  /** When this process last let go of edges gone quiet. */
  #forgotAt = 0
  /** Starts joins asked for that are under way, by server: joins that arrive together share one. */
  readonly #starts = new Map<string, Promise<WakeResult | null>>()

  constructor(deps: {
    db: Db
    addressing: PlayAddressing
    runtime: Runtimes
    service: MinecraftServerService
    waiter: ServerWaiter
    schedules: Schedules
    events: EventBus
    links: ArtifactLinks
    /** The runtime keyring, which keys the hashes known addresses are kept as (`known-addresses.ts`). */
    runtimeSecrets: SecretKeyring
    wakeWaitMs: number
    routeChanges?: ChangeSignal
  }) {
    this.#db = deps.db
    this.#addressing = deps.addressing
    this.#runtime = deps.runtime
    this.#service = deps.service
    this.#waiter = deps.waiter
    this.#schedules = deps.schedules
    this.#events = deps.events
    this.#links = deps.links
    this.#keyring = deps.runtimeSecrets
    this.#wakeWaitMs = deps.wakeWaitMs
    this.#changes = deps.routeChanges ?? null
  }

  /** Every hostname that should route, with where the edge sends it. */
  async routes(): Promise<EdgeRoutes> {
    return (await this.listed()).routes
  }

  /**
   * The routes, and the database's time as their read began: an edge that holds this very list
   * holds the route of every server named running before then (`routed.ts`). The first list to
   * name a server running says so on it; nothing else is written. `unrouted` says whether a
   * running server still waits on the edges to hold it.
   *
   * What they are read from is read again only when its fingerprint moves (`inputs.ts`); what
   * they are built from beside it, the runtimes' endpoints and the time, is asked every time.
   */
  async listed(): Promise<{ routes: EdgeRoutes; from: Date; unrouted: boolean }> {
    const { print, inputs } = await this.#inputs()
    const { servers: live, bindings, comingBack, stops, trials, motds, plays } = inputs
    const restarting = restartingOf(live, comingBack)
    const unstoring = new Set(comingBack.filter((o) => o.kind === 'unstore').map((o) => o.serverId))
    const out = outOf(stops, new Date())
    const over = trialOver(trials)
    const routes: EdgeRoutes['routes'] = []
    for (const server of live) {
      const { state, back, waking } = runOf(
        server.status,
        restarting.has(server.id),
        unstoring.has(server.id),
      )
      const binding = bindings.get(server.id)
      const destination = back ? NOWHERE : this.#destinationOf(server.status, state, binding?.handle)
      if (destination === null) continue
      for (const { address, alias } of this.#addressesOf(server.slug)) {
        routes.push({
          hostname: address.hostname,
          ...alias,
          destination,
          ...noticeOf(state, server, out.get(server.id), over.has(server.id)),
          ...(waking ? { waking: true as const } : {}),
          ...this.#identityOf(server, state, motds),
          ...(binding?.proxyProtocol ? { proxyProtocol: true as const } : {}),
          ...joinsOf(plays, state, binding, server.desiredRevisionId),
        })
      }
    }
    routes.sort((a, b) => a.hostname.localeCompare(b.hostname))
    // Each running server with a handle is routed to, above.
    if (print.unlisted)
      await markListed(
        this.#db,
        live.filter((s) => s.status === 'running' && bindings.get(s.id)?.handle).map((s) => s.id),
      )
    return { routes: { routes, releases: [...RELEASES] }, from: print.from, unrouted: print.unrouted }
  }

  /**
   * Every address the server at `slug` is routed at: its own, and the kept addresses that point at
   * it, which say whose they are. A kept address is never given to a server; one that had it
   * before is not routed at it.
   */
  #addressesOf(slug: string): { address: PlayAddress; alias: { aliasOf?: string } }[] {
    const own = keptFor(slug) === null ? this.#addressing.all(slug) : []
    return [
      ...own.map((address) => ({ address, alias: {} })),
      ...keptAt(slug).flatMap((kept) =>
        this.#addressing.all(kept).map((address) => ({ address, alias: { aliasOf: slug } })),
      ),
    ]
  }

  /**
   * The route inputs, read again only when their fingerprint has moved since they last were. The
   * fingerprint itself is read again only when the database said something it is made of moved,
   * a server waits on the edges, or `FINGERPRINT_BACKSTOP_MS` has passed. Meanwhile the version
   * is the database's time now, reckoned from this clock as the last read measured it, so never
   * later than the database's own: nothing the list is made of has moved since, so it still
   * holds as of then. Word of a write comes a moment after it, which only delays the next read:
   * a server is marked listed by a read, never by this.
   */
  async #inputs(): Promise<{ print: Fingerprint; inputs: RouteInputs }> {
    const providers = this.#runtime.providers
    // Taken before the read, so a write the read misses moves it after.
    const mark = this.#changes?.mark() ?? null
    const kept = this.#read
    if (
      kept !== null &&
      mark !== null &&
      mark === kept.mark &&
      !kept.print.unrouted &&
      !kept.print.unlisted &&
      Date.now() - kept.at < FINGERPRINT_BACKSTOP_MS
    )
      return { print: { ...kept.print, from: new Date(Date.now() + kept.offset) }, inputs: kept.inputs }
    let print = await fingerprint(this.#db, providers)
    let inputs = kept?.print.digest === print.digest ? kept.inputs : null
    if (inputs === null) {
      const fresh = await readInputs(this.#db, providers)
      print = fresh.fingerprint
      inputs = fresh.inputs
    }
    const at = Date.now()
    this.#read = { inputs, print, mark, at, offset: +print.from - at }
    return { print, inputs }
  }

  /** Where a server's route sends a player; null for a server that has no route. */
  #destinationOf(
    status: ServerStatus,
    state: 'asleep' | 'restarting' | null,
    handle: RuntimeHandle | null | undefined,
  ): string | null {
    // A running server being restored is routed only so its players are told it is restarting:
    // the edge dials nothing while it is.
    if (!handle || !(ROUTABLE.includes(status) || state === 'restarting')) return null
    // An address the provider may give to other compute once this server stops is only its own
    // while it runs: until then the route names nothing at all.
    return this.#runtime.stableEndpoint(handle) || state === null
      ? destinationOf(this.#runtime.endpoint(handle, PORT_NAMES.game, 'edge'))
      : NOWHERE
  }

  /**
   * Edge `edgeId` asked for its routes, holding the list read from `syncedTo` on, or a list it
   * would not be handed now (null). While no server waits on the edges (`unrouted` false), its
   * word is written only every `EDGE_SAID_EVERY_MS`, which keeps it counted: nothing reads its
   * version but a server that waits. `startedAt` is when its agent started, if it says.
   */
  async seen(
    edgeId: string,
    syncedTo: Date | null,
    unrouted = true,
    startedAt: Date | null = null,
  ): Promise<void> {
    const now = Date.now()
    // A restart is written at once, however lately the edge's word was: it is what the alert waits on.
    const restarted = startedAt !== null && this.#startedOf.get(edgeId) !== +startedAt
    if (unrouted || restarted) {
      this.#saidAt.set(edgeId, now)
      await seen(this.#db, this.#events, edgeId, syncedTo, startedAt)
      // Remembered once written, so a write that failed is tried again by the next ask.
      if (startedAt !== null) this.#startedOf.set(edgeId, +startedAt)
      return
    }
    if (now - (this.#saidAt.get(edgeId) ?? 0) < EDGE_SAID_EVERY_MS) return
    this.#saidAt.set(edgeId, now)
    await sawEdge(this.#db, edgeId, syncedTo, startedAt)
    if (startedAt !== null) this.#startedOf.set(edgeId, +startedAt)
    if (now - this.#forgotAt < HOUR_MS) return
    this.#forgotAt = now
    await forgetQuietEdges(this.#db)
  }

  /**
   * What the server list shows of an asleep server, where its owner made it their own: the message
   * it starts with next, and its picture. Blockly's welcome and its default picture are left out,
   * so the edge says only that it sleeps.
   */
  #identityOf(
    server: RouteServer,
    state: 'asleep' | 'restarting' | null,
    motds: ReadonlyMap<string, string>,
  ): Pick<EdgeRoutes['routes'][number], 'motd' | 'icon'> {
    if (state !== 'asleep') return {}
    const motd = server.desiredRevisionId === null ? undefined : motds.get(server.desiredRevisionId)
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
   * seconds, and start it again each time. `name`: the name the join gave as it began to log in,
   * which only chooses whether its wake counts among the hour's (`#mayStart`).
   */
  async wake(hostname: string, retries = true, name?: string): Promise<WakeResult> {
    const result = await this.#wakeFor(hostname, retries, name)
    wakeAnswered(
      result.outcome,
      result.outcome === 'denied'
        ? result.reason
        : result.outcome === 'starting'
          ? (result.behind ?? null)
          : null,
    )
    return result
  }

  async #wakeFor(hostname: string, retries: boolean, name: string | undefined): Promise<WakeResult> {
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
    // By the database's clock, which writes the starts this wake may ask for: this one may differ.
    const began = await databaseNow(this.#db)
    const result = await this.#woken(server, left, retries, name)
    if (result.outcome !== 'ready' && result.outcome !== 'starting') return result
    const [start] = await wakeStarts(this.#db, server.id, began)
    return start === undefined ? result : { ...result, wakeOperationId: start.id }
  }

  /** What a join to `server` is told, once it is up or the wait is over. */
  async #woken(
    server: MinecraftServer,
    left: () => number,
    retries: boolean,
    name: string | undefined,
  ): Promise<WakeResult> {
    const settled = await this.#settled(server, left)
    if (typeof settled === 'object') return settled

    if (settled !== 'running') {
      const unstarted = await this.#shared(server, settled, name, left, retries)
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
   * Starts `server` for a join, or waits on the start another join asked for that is under way:
   * null once it runs, or what the join is told. Where the other join's wake started nothing, this
   * one is weighed for itself.
   */
  async #shared(
    server: MinecraftServer,
    status: ServerStatus,
    name: string | undefined,
    left: () => number,
    retries: boolean,
  ): Promise<WakeResult | null> {
    for (;;) {
      const under = this.#starts.get(server.id)
      if (under === undefined) break
      const shared = await under
      if (shared?.outcome !== 'asleep') return shared
    }
    const start = this.#mayStart(server.id, status, name)
      .then((may) => (may ? this.#start(server, left, retries) : LEFT_ASLEEP))
      .finally(() => this.#starts.delete(server.id))
    this.#starts.set(server.id, start)
    return start
  }

  /**
   * Whether a join may start the server. One already starting starts nothing new. A player the
   * server itself has seen on it before always may; the hours its owner's plan includes bound what
   * their wakes run. Every other join shares the hour's wakes nobody joined
   * (`AbuseLimits.wakesPerHour`), and once those are used, the server is left asleep; a woken run
   * nobody joins sleeps after the probation (WAKE_PROBATION_MS).
   */
  async #mayStart(serverId: string, status: ServerStatus, name: string | undefined): Promise<boolean> {
    if (status === 'starting') return true
    if (name !== undefined && (await playedHere(this.#db, serverId, name))) return true
    return (await unjoinedWakes(this.#db, serverId, new Date())) < tuning().abuse.wakesPerHour
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
      return rested === null ? await this.#stillStarting(server.id) : server.lifecycle.status
    }
    return server.lifecycle.status
  }

  /**
   * Starts the server and waits for it to run: null once it does, or what the join is told. A
   * server that moved on to other work between the join's read and its start (its rest began, or
   * a move) is waited for, as it would have been had the join read it first, and asked once more.
   * A server that is there is never told it isn't: one that moves on again is still on its way.
   */
  async #start(server: MinecraftServer, left: () => number, retries: boolean): Promise<WakeResult | null> {
    const first = await this.#startOnce(server, left, retries)
    if (first !== MOVED_ON) return first
    const latest = await findServer(this.#db, server.id)
    const status = latest?.lifecycle.status
    if (latest === null || status === 'deleted' || status === 'purged')
      return { outcome: 'denied', reason: 'deleted' }
    const settled = await this.#settled(latest, left)
    if (typeof settled === 'object') return settled
    if (settled === 'running') return null
    const again = await this.#startOnce(latest, left, retries)
    return again === MOVED_ON ? this.#stillStarting(server.id) : again
  }

  /**
   * Starts the server through the same checks as the UI, and waits for it to run: null once it
   * does, or what the join is told when it was refused or hasn't by the time `left` runs out;
   * `MOVED_ON` when the server moved on to other work between the join's read and its start.
   */
  async #startOnce(
    server: MinecraftServer,
    left: () => number,
    retries: boolean,
  ): Promise<WakeResult | null | typeof MOVED_ON> {
    const failed = await this.#failed(server)
    if (failed === 'running' || (failed === 'waking' && !retries))
      return { outcome: 'denied', reason: failed === 'waking' ? 'failed' : 'broken' }
    if (failed === 'settling') {
      const settled = await this.#settleAgain(server.id, left)
      if (settled !== 'stopped') return settled
    }
    const asked = await this.#ask(server, failed === 'waking')
    if (asked !== null) return asked
    const status = await this.#waiter.waitFor(server.id, ['running', 'failed', 'stopped', 'stored'], left())
    if (status === 'failed') return { outcome: 'denied', reason: 'failed' }
    return status === 'running' ? null : this.#stillStarting(server.id)
  }

  /**
   * Asks for the start, or for a failed wake to be tried again (`retrying`): null once it is
   * asked for, or runs already because a join at another edge asked first.
   */
  async #ask(server: MinecraftServer, retrying: boolean): Promise<WakeResult | typeof MOVED_ON | null> {
    try {
      if (retrying) await this.#service.retry(WAKE, server.id, crypto.randomUUID())
      else await this.#service.start(WAKE, server.id, crypto.randomUUID())
      return null
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      if (error.code !== 'invalid_transition') return this.#refused(server, error)
      // A join at another edge asked first, and the start it asked for runs: this one waits on it.
      // Any other status: the server moved on (a rest, a move) after the join read it.
      return (await findServer(this.#db, server.id))?.lifecycle.status === 'starting' ? null : MOVED_ON
    }
  }

  /**
   * Blockly's own stop or move failed for good, and left the server's compute off: the join tries
   * that again, as "Try again" would. `stopped` once it has settled where a start can go on (a
   * world at rest included), null when it came back running, or what the join is told.
   */
  async #settleAgain(serverId: string, left: () => number): Promise<WakeResult | null | 'stopped'> {
    await this.#service.retry(WAKE, serverId, crypto.randomUUID()).catch((error: unknown) => {
      // Another join tried it again first: this one waits on the same work.
      if (!(error instanceof AppError) || error.code !== 'invalid_transition') throw error
    })
    const settled = await this.#waiter.waitFor(serverId, ['stopped', 'stored', 'running', 'failed'], left())
    if (settled === null) return this.#stillStarting(serverId)
    if (settled === 'failed') return { outcome: 'denied', reason: 'failed' }
    return settled === 'running' ? null : 'stopped'
  }

  /**
   * A join told the server still starts, and what the start waits behind, where it waits on other
   * work on the server: its world being put to rest, its going to sleep, or a backup. The player
   * hears it when the join can't wait any longer.
   */
  async #stillStarting(serverId: string): Promise<WakeResult> {
    const [first] = await openOfKinds(this.#db, [serverId], [...BEHIND.keys()])
    const behind = first === undefined ? undefined : BEHIND.get(first.kind)
    return { outcome: 'starting', ...(behind === undefined ? {} : { behind }) }
  }

  /**
   * How the server last failed for good, where it did: `waking`, in waking it (a resume that hung,
   * a host that couldn't run it), which the next join tries again within the hourly cap;
   * `settling`, in a stop, or a move Blockly made itself, which ended with its compute forced off
   * and is Blockly's, so the next join tries that again and then wakes it, within the same cap;
   * `running`, over what the server runs (a broken mod, a crash), which would only fail again and
   * is its owner's. Read now: what the join waited through may have ended in one.
   */
  async #failed(server: MinecraftServer): Promise<'waking' | 'settling' | 'running' | null> {
    const { lifecycle } = (await findServer(this.#db, server.id)) ?? server
    if (lifecycle.status !== 'failed') return null
    const { failure } = lifecycle
    if (failure === null) return 'running'
    if (failure.during === 'stopping') return 'settling'
    if (failure.during === 'relocating') {
      const move = await loadOperation(this.#db, failure.operationId)
      return move?.requestedBy.startsWith('system:') ? 'settling' : 'running'
    }
    const waking = failure.during === 'starting' && (await failedWaking(this.#db, failure.operationId))
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
    const between = servers.filter((s) => BETWEEN_RUNS.includes(s.lifecycle.status)).map((s) => s.id)
    const open = await openOfKinds(this.#db, between, ['restart', 'restore', 'relocate'])
    return restartingOf(
      servers.map((s) => ({ id: s.id, status: s.lifecycle.status })),
      open.map((o) => ({ serverId: o.serverId, kind: o.kind, running: o.input.running === true })),
    )
  }

  /**
   * A server list at `address` asked how an asleep server is: the server may start now, before
   * anyone joins (`ping-wake.ts`). Answers at once, whether or not it started it.
   */
  pingWake(hostname: string, address?: string): Promise<PingWakeResult> {
    const deps = {
      db: this.#db,
      addressing: this.#addressing,
      service: this.#service,
      keyring: this.#keyring,
    }
    return pingWake(deps, hostname, address)
  }

  /** `known-addresses`: forgets the networks that no longer wake a server with a ping. */
  forgetAddresses(): Promise<number> {
    return forgetAddresses(this.#db, new Date())
  }

  /** The edge saw no players for a while. Only the idle policy decides whether to stop. */
  async idleHint(hostname: string): Promise<IdleDecision | 'not_running'> {
    const slug = this.#addressing.slugFor(hostname)
    const server = slug === null ? null : await findLiveBySlug(this.#db, slug)
    if (server?.lifecycle.status !== 'running') return 'not_running'
    return this.#schedules.evaluateIdle(server)
  }

  /**
   * A connect or disconnect the edge saw. The identity is claimed by the client: display only, and
   * a join's network is kept only where the server itself saw that player (`known-addresses.ts`).
   */
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
      // Let in to wait for a server resting for its owner's play: the edge can only turn it away.
      const resting = event.event === 'connect' ? await restingFor(tx, server, new Date()) : null
      if (resting !== null) await turnedAway(tx, server, player, resting, new Date(event.at))
      if (event.event === 'disconnect')
        await joinEnded(tx, this.#keyring, server.id, event.address, player, new Date(event.at))
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
 * Which of `servers` are on their way back from a restart, by `open`, the open restarts, restores
 * and moves among them: a restore or a move comes back running only when it began on a running
 * server.
 */
function restartingOf(
  servers: ReadonlyArray<{ id: string; status: ServerStatus }>,
  open: ReadonlyArray<{ serverId: string; kind: string; running: boolean }>,
): Set<string> {
  const restarting = new Set(servers.filter((s) => s.status === 'updating').map((s) => s.id))
  const between = new Set(servers.filter((s) => BETWEEN_RUNS.includes(s.status)).map((s) => s.id))
  for (const operation of open)
    if (between.has(operation.serverId) && (operation.kind === 'restart' || operation.running))
      restarting.add(operation.serverId)
  return restarting
}

/**
 * Which players' games a route's server takes, from what its revision runs and the Via plugins
 * Cubepals placed beside it (`clientRange`): what the edge turns other joins away by. A running
 * server takes what the run it is in booted, which a change saved since doesn't move until it
 * boots, with only the Via plugins that boot placed (none, for a boot from before one said); any
 * other, what it starts with next, with those pinned for its release that its choice asks for.
 * Nothing for a server whose release the table doesn't know.
 */
function joinsOf(
  plays: RouteInputs['plays'],
  state: 'asleep' | 'restarting' | null,
  binding: { revisionId: string | null; compat: string[] | null } | undefined,
  desired: string | null,
): Pick<EdgeRoutes['routes'][number], 'joins'> {
  const booted = state === null ? (binding?.revisionId ?? null) : null
  const revisionId = booted ?? desired
  const runs = revisionId === null ? undefined : plays.get(revisionId)
  const adds =
    booted === null
      ? COMPAT[runs?.otherVersions ?? 'off'].filter((id) => runs?.pinned.includes(id))
      : (binding?.compat ?? [])
  const range = runs === undefined ? null : clientRange(runs.gameVersion, runs.loader, runs.mods, adds)
  if (range === null) return {}
  const { release, protocol, oldest, newest } = range
  return { joins: { release, protocol, oldest, ...(newest === null ? {} : { newest }) } }
}

/**
 * Where a server's run is, as its routes say: why it can't be joined now (null while it runs);
 * whether its world is coming back from rest (`back`), which has nothing to dial until it is, but
 * whose ping is told it wakes and whose join waits in the waiting room; and whether it is on its
 * way up (`waking`).
 */
function runOf(
  status: ServerStatus,
  restarting: boolean,
  unstoring: boolean,
): { state: 'asleep' | 'restarting' | null; back: boolean; waking: boolean } {
  const state = status === 'running' ? null : restarting ? 'restarting' : 'asleep'
  const back = status === 'restoring' && unstoring
  return { state, back, waking: state === 'asleep' && (status === 'starting' || back) }
}

/**
 * What a route says about a server that isn't running: why, and for one asleep because its owner's
 * play ran out, its name and when it is back: at their next day for the day's play (`backAt`), or
 * not by itself for the free trial's hours (`trialOver`).
 */
function noticeOf(
  state: 'asleep' | 'restarting' | null,
  server: Pick<RouteServer, 'name'>,
  backAt: Date | undefined,
  trial: boolean,
): Pick<EdgeRoutes['routes'][number], 'state' | 'backAt' | 'trialOver' | 'name'> {
  if (state !== 'asleep') return state === null ? {} : { state }
  if (trial) return { state, trialOver: true, name: server.name }
  return backAt === undefined ? { state } : { state, backAt: backAt.toISOString(), name: server.name }
}

/**
 * A destination the edge can't dial: nothing listens on port 0, so a status ping fails at once and
 * gets the asleep message, and a join asks for a wake.
 */
export const NOWHERE = '0.0.0.0:0'

/** Where the edge dials: `host:port`, with an IPv6 address in brackets, as dialers read it. */
export const destinationOf = (endpoint: Endpoint): string =>
  endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`
