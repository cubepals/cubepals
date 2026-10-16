// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// The edge agent: the only code that knows mc-router exists. It turns the control plane's edge
// protocol (routes, wake, idle, sessions) into mc-router's routes (router.ts) and webhooks, and
// supervises mc-router itself. Replacing mc-router means rewriting this file and router.ts.

import { connect, createServer, type Socket } from 'node:net'
import { hostname } from 'node:os'
import type { EdgeRoutes, PingWakeResult, SessionEvent, WakeResult } from '@blockly/contracts/edge'
// Copied into the image beside the agent (Dockerfile): the one place play coming back is worded.
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { EDGE_ID_HEADER, NEWER_REASONS } from '../../packages/contracts/src/edge-poll.ts'
import { waitFor } from '../../packages/contracts/src/play-today.ts'
import { LOCAL_HEADER, readProxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { OWN_ICON_MAX_BYTES } from '../../packages/contracts/src/server-list.ts'
import { GAME_PORT } from '../control/src/minecraft/ports.ts'
import { asleepMessage } from './asleep.ts'
import { takes, wrongGame } from './clients.ts'
import { front, pipe } from './front.ts'
import { forServer, Unwrap } from './header.ts'
import { Held, LOGIN_QUERIES, turnAway } from './hold.ts'
import { Gate } from './limits.ts'
import { mappings } from './mappings.ts'
import { hostnameOf, type Join, Notice, type NoticeText, pingOf, statusRequest } from './notice.ts'
import { PingWakes } from './ping-wake.ts'
import { RoutesPoll } from './poll.ts'
import { RouterRoutes } from './router.ts'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

const CONTROL_URL = env('CONTROL_URL').replace(/\/$/, '')
const TOKEN = env('EDGE_TOKEN')
const EDGE_ID = env('EDGE_ID', hostname())
const AGENT_PORT = Number(env('AGENT_PORT', '8090'))
// Routes are what the router knows about a hostname, and a server reads as running only once
// every edge holds its route, so this is short on purpose: every poll but the first after a
// change is an ETag 304.
const POLL_MS = Number(env('ROUTES_POLL_MS', '1000'))
/** Where a restarting server's hostname goes instead of to the server: this agent's own notice. */
const NOTICE = `127.0.0.1:${env('NOTICE_PORT', '25564')}`
const RESTARTING = {
  status: env('RESTARTING_MOTD', 'Restarting · back in a moment'),
  join: env('RESTARTING_JOIN', 'Restarting · join again in a moment'),
} satisfies NoticeText
/** Where a sleeping server's hostname goes: a notice of the agent's that passes joins on. */
const SLEEPING = `127.0.0.1:${env('SLEEPING_PORT', '25563')}`
const ASLEEP: NoticeText = { status: env('ASLEEP_MOTD', 'Sleeping · join to wake it up'), join: null }
/** What a ping is told of a sleeping server on its way up, woken by a join or by a ping before it. */
const WAKING_MOTD = env('WAKING_MOTD', 'Waking up · join in a few seconds')
/**
 * How long a ping waits to hear whether its server is waking before it is answered, and how long
 * an answer stands before another ping asks again.
 */
const PING_WAKE_WAIT_MS = Number(env('PING_WAKE_WAIT_MS', '1500'))
const PING_WAKE_EVERY_MS = Number(env('PING_WAKE_EVERY_MS', '30000'))
/** A sleeping server whose owner's plan has no play left today, until it is back at their midnight. */
const usedToday = (backAt: string): string =>
  `Today’s play is used up · back at midnight, in ${waitFor(new Date(), new Date(backAt))}`
/** Where a join goes that has to wait for its server: the agent's waiting room, which wakes it. */
const WAITING = `127.0.0.1:${env('WAITING_PORT', '25562')}`
/** How long the waiting room holds a join for its server to come up, before asking for another try. */
const HOLD_MS = Number(env('WAKE_HOLD_MS', '180000'))
/** What a held join is told when it can't go on, by why. Every one of them reaches a player. */
const TURNED_AWAY = {
  starting: env('STILL_STARTING_JOIN', 'Still starting · join again in a moment'),
  // A start that waited on other work on the server, which a login screen has no room to say.
  rest: env('STILL_RESTING_JOIN', 'Still saving this server’s world · join again in a moment'),
  stop: env('STILL_STOPPING_JOIN', 'Still going to sleep · join again in a moment'),
  backup: env('STILL_BACKING_UP_JOIN', 'Still taking a backup · join again in a moment'),
  restarting: RESTARTING.join,
  unreachable: env('UNREACHABLE_JOIN', 'Couldn’t start this server just now · join again in a moment'),
  failed: env('FAILED_JOIN', 'Couldn’t start this server just now · try again in a minute'),
  broken: env('REFUSED_JOIN', 'This server can’t start right now · its owner can see why on Cubepals'),
  unknown: env('UNKNOWN_JOIN', 'There’s no Cubepals server at this address'),
  deleted: env('DELETED_JOIN', 'This server was deleted'),
  paused: env('PAUSED_JOIN', 'Cubepals isn’t starting servers right now · try again soon'),
  suspended: env('REFUSED_JOIN', 'This server can’t start right now · its owner can see why on Cubepals'),
  quota: env('REFUSED_JOIN', 'This server can’t start right now · its owner can see why on Cubepals'),
} as const

/** Where players connect: the agent's front door, which hands what it lets in to mc-router. */
const MINECRAFT_PORT = Number(env('MINECRAFT_PORT', String(GAME_PORT)))
/** Where mc-router listens instead, reached only through the front door. */
const ROUTER_PORT = Number(env('ROUTER_PORT', '25561'))
/** Where mc-router's API listens, on this machine only: how its routes change (router.ts). */
const ROUTER_API = `127.0.0.1:${env('ROUTER_API_PORT', '25560')}`
/** How long a connection to a server may wait to connect, and then go quiet (front.ts). */
const TIMEOUTS = {
  connectMs: Number(env('CONNECT_TIMEOUT_MS', String(10 * SECOND_MS))),
  idleMs: Number(env('IDLE_TIMEOUT_MS', String(MINUTE_MS))),
}
/** How much one address, and one server, may ask of the edge (limits.ts). */
const LIMITS = {
  address: {
    connections: {
      perSecond: Number(env('ADDRESS_CONNECTIONS_PER_SECOND', '5')),
      burst: Number(env('ADDRESS_CONNECTIONS_BURST', '30')),
    },
    greeting: Number(env('ADDRESS_GREETING', '10')),
  },
  server: {
    connections: {
      perSecond: Number(env('SERVER_CONNECTIONS_PER_SECOND', '20')),
      burst: Number(env('SERVER_CONNECTIONS_BURST', '100')),
    },
    open: Number(env('SERVER_OPEN_CONNECTIONS', '300')),
  },
}

const control = (path: string, init: RequestInit = {}) =>
  fetch(`${CONTROL_URL}/edge/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      [EDGE_ID_HEADER]: EDGE_ID,
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  })

// ─── Routes: pulled, so every edge machine converges and a restart loses nothing ────────────

const router = new RouterRoutes(`http://${ROUTER_API}`)
/** What the control plane last said. */
let routes: EdgeRoutes['routes'] = []
/** Each Minecraft release and its client's protocol number, as the control plane last said. */
let releases: NonNullable<EdgeRoutes['releases']> = []
/** Every hostname those routes name. */
let hostnames = new Set<string>()
/** Hostnames of running servers that read no PROXY header: the front door sends them none. */
let plain = new Set<string>()
/**
 * Destinations of running servers that didn't answer: restarting without Blockly asking, as when
 * the provider brings a crashed one back. Their players are told so until they answer again.
 */
const unreachable = new Set<string>()
/** When each running server was last asked whether it answers. */
const asked = new Map<string, number>()

/** Has mc-router hold the routes, changing only what differs; whether it holds them all. */
async function applyRoutes(): Promise<boolean> {
  try {
    await router.apply(mappings(routes, unreachable, { restarting: NOTICE, asleep: SLEEPING }))
    return true
  } catch (error) {
    // Not held, so not said to be: the next poll fetches the list again, and applies it again.
    poll.forget()
    console.error('mc-router refused a route; trying again at the next poll', error)
    return false
  }
}

const poll = new RoutesPoll(
  (headers) => control('/routes', { headers }),
  (next) => {
    routes = next.routes
    releases = next.releases ?? []
    hostnames = new Set(routes.map((r) => r.hostname))
    plain = new Set(routes.filter((r) => r.state === undefined && !r.proxyProtocol).map((r) => r.hostname))
    const running = new Set(routes.filter((r) => r.state === undefined).map((r) => r.destination))
    for (const destination of unreachable) if (!running.has(destination)) unreachable.delete(destination)
    for (const destination of asked.keys()) if (!running.has(destination)) asked.delete(destination)
    return applyRoutes()
  },
)

/** Asks for the routes, and applies them if they changed; whether they did. */
async function syncRoutes(): Promise<boolean> {
  try {
    return await poll.sync()
  } catch (error) {
    console.error('route sync failed; keeping the last known routes', error)
    return false
  }
}

// ─── Sleeping servers' pictures, fetched once each ──────────────────────────────────────────

/**
 * Each picture a route names, by its link, as the server list takes it; null while it is being
 * fetched, or for a minute after it couldn't be. A link names one picture for good, so a picture
 * fetched is never fetched again.
 */
const icons = new Map<string, string | null>()

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Fetches the pictures of sleeping servers not fetched yet, and forgets those no route names. */
function fetchIcons(): void {
  const named = new Set(routes.flatMap((r) => (r.state === 'asleep' && r.icon ? [r.icon] : [])))
  for (const link of icons.keys()) if (!named.has(link)) icons.delete(link)
  for (const link of named) {
    if (icons.has(link)) continue
    icons.set(link, null)
    void fetch(link, { signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`answered ${response.status}`)
        const png = new Uint8Array(await response.arrayBuffer())
        if (png.length > OWN_ICON_MAX_BYTES || !PNG.every((byte, i) => png[i] === byte))
          throw new Error('not a picture the list takes')
        if (icons.has(link)) icons.set(link, `data:image/png;base64,${Buffer.from(png).toString('base64')}`)
      })
      .catch((error) => {
        // Until it is asked again, the list draws its default picture.
        setTimeout(() => icons.delete(link), MINUTE_MS)
        console.error('a sleeping server’s picture could not be fetched', error)
      })
  }
}

// ─── Running servers that don't answer, watched until they do ──────────────────────────────

/** Whether the running server at `destination` reads a PROXY header, as its route says. */
const readsHeader = (destination: string): boolean =>
  routes.some((r) => r.state === undefined && r.destination === destination && r.proxyProtocol === true)

/**
 * Whether the server at `destination` answers a status request, as a player's server list asks.
 * One that reads a PROXY header is sent a LOCAL one first: the request is the edge's own.
 */
function answers(destination: string, proxied = readsHeader(destination)): Promise<boolean> {
  const colon = destination.lastIndexOf(':')
  const host = destination.slice(0, colon).replace(/^\[|\]$/g, '')
  const port = Number(destination.slice(colon + 1))
  asked.set(destination, Date.now())
  return new Promise((resolve) => {
    // Only an answer counts: a provider's proxy can take the connection for a server that isn't
    // up, and close it or leave it hanging.
    const socket = connect({ host, port, timeout: 3_000 })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }
    socket.once('connect', () => socket.write(forServer(proxied, LOCAL_HEADER, statusRequest(host, port))))
    socket.once('data', () => done(true))
    socket.once('close', () => done(false))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Someone reached for a running server: if it wasn't asked moments ago, is it answering? */
async function check(destination: string): Promise<void> {
  if (unreachable.has(destination) || Date.now() - (asked.get(destination) ?? 0) < 5_000) return
  if (!routes.some((r) => r.state === undefined && r.destination === destination)) return
  if (await answers(destination)) return
  unreachable.add(destination)
  await applyRoutes()
}

setInterval(async () => {
  let changed = false
  for (const destination of unreachable) {
    if (!(await answers(destination))) continue
    unreachable.delete(destination)
    changed = true
  }
  if (changed) await applyRoutes()
}, 2_000)

// ─── mc-router's webhooks, translated ───────────────────────────────────────────────────────

/**
 * A join, which mc-router asks about before it connects one. A running server's goes straight to
 * it. Any other waits in the waiting room, which wakes it: mc-router would otherwise hold the join
 * through the wake without a word, and a client gives up on that after 30 s, well before a wake is
 * over (§12).
 */
async function wake(serverAddress: string): Promise<Response> {
  // mc-router asks with no address at all when it holds no route for the hostname: a server
  // created seconds ago, before this agent's next poll. The waiting room asks by the address the
  // client dialled, which the control plane already knows.
  const route = routes.find((r) => r.hostname === serverAddress)
  if (route === undefined || route.state !== undefined) return Response.json({ backend: WAITING })
  const result = await wakeOnce(serverAddress).catch(() => null)
  if (result?.outcome !== 'ready') return Response.json({ backend: WAITING })
  // Running, as far as Blockly knows, but not answering: the join waits a while for it to come
  // back, and is otherwise told it is restarting. A join is rare enough to always ask.
  if (
    !unreachable.has(result.destination) &&
    !(await answers(result.destination, result.proxyProtocol === true))
  ) {
    unreachable.add(result.destination)
    await applyRoutes()
  }
  const deadline = Date.now() + 20_000
  while (unreachable.has(result.destination) && Date.now() < deadline) await Bun.sleep(1_000)
  return Response.json({ backend: unreachable.has(result.destination) ? NOTICE : result.destination })
}

/** Wakes in flight, by hostname: joins that arrive together share one. */
const waking = new Map<string, Promise<WakeResult>>()

/** Asks the control plane to wake a server, which waits up to 25 s for it to come up. */
function wakeOnce(hostname: string): Promise<WakeResult> {
  const inFlight = waking.get(hostname)
  if (inFlight) return inFlight
  const body = JSON.stringify({ hostname, understands: NEWER_REASONS })
  const asked = control('/wake', { method: 'POST', body })
    .then(async (response) => {
      if (!response.ok) throw new Error(`wake answered ${response.status}`)
      return (await response.json()) as WakeResult
    })
    .finally(() => waking.delete(hostname))
  waking.set(hostname, asked)
  return asked
}

interface RouterSession {
  event?: string
  timestamp?: string
  status?: string
  server?: string
  player?: { name?: string; uuid?: string }
  /** Where the client connected from: the front door's PROXY header, which mc-router trusts. */
  client?: { host?: string }
  backend?: string
}

async function session(body: RouterSession): Promise<void> {
  // Told it is restarting is not a join, and must not keep the server up as one.
  if (body.backend === NOTICE) return
  // Every connection, a server list's included, is a chance to notice a server that stopped answering.
  if (body.event === 'connect' && body.backend) void check(body.backend)
  const event = body.event === 'connect' || body.event === 'disconnect' ? body.event : null
  if (event === null || !body.server || !body.player?.name || !body.player.uuid) return
  if (event === 'connect' && body.status !== 'success') return
  const payload: SessionEvent = {
    edgeId: EDGE_ID,
    hostname: body.server,
    event,
    player: { name: body.player.name, uuid: body.player.uuid },
    ...(body.client?.host ? { address: body.client.host } : {}),
    at: body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString(),
  }
  await control('/sessions', { method: 'POST', body: JSON.stringify(payload) })
}

Bun.serve({
  hostname: '127.0.0.1',
  port: AGENT_PORT,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (path === '/scale') {
      const address = String(body.serverAddress ?? '')
      if (body.action === 'up') return wake(address)
      if (body.action === 'down')
        await control('/idle', { method: 'POST', body: JSON.stringify({ hostname: address }) }).catch(
          () => undefined,
        )
      return new Response(null, { status: 204 })
    }
    if (path === '/session') {
      await session(body as RouterSession).catch((error) => console.error('session report failed', error))
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  },
})

// ─── The notice ─────────────────────────────────────────────────────────────────────────────

Bun.listen<{ notice: Notice; unwrap: Unwrap }>({
  hostname: '127.0.0.1',
  port: Number(NOTICE.split(':')[1]),
  socket: {
    open(socket) {
      socket.data = { notice: new Notice(RESTARTING), unwrap: new Unwrap() }
      socket.timeout(10)
    },
    data(socket, chunk) {
      const own = socket.data.unwrap.take(chunk)
      if (own === 'bad') return void socket.end()
      if (own === null) return
      const { reply, close } = socket.data.notice.receive(own)
      for (const bytes of reply) socket.write(bytes)
      if (close) socket.end()
    },
    timeout(socket) {
      socket.end()
    },
  },
})

// ─── A sleeping server's notice ──────────────────────────────────────────────────────────────

// mc-router asks the wake webhook for a join, and dials a server's route only for a ping, or for a
// join that arrived while another was waking the server. Dialled directly, a sleeping server's
// ping goes unanswered on Fly: its proxy takes the connection even while the machine is stopped.
// So the route leads here. A ping is told the server sleeps; the rare join that still arrives
// comes once the wake is over, and goes on to the server as it would have without this.

/** Connects a join handed back by the notice to the server its address routes to. */
function passOn(client: Socket, join: Join, header: Uint8Array | null): void {
  const route = routes.find((r) => r.hostname === hostnameOf(join))
  if (!route) {
    client.destroy()
    return
  }
  pipe(client, route.destination, forServer(route.proxyProtocol === true, header, join.bytes), TIMEOUTS)
}

/** Sleeping servers a ping asked to wake early, so each is asked once a while (`ping-wake.ts`). */
const pingWakes = new PingWakes(
  (hostname, address) =>
    control('/ping-wake', {
      method: 'POST',
      body: JSON.stringify({ hostname, ...(address === null ? {} : { address }) }),
    }).then(
      // A control plane from before it took these answers 404: the server stays asleep.
      async (response) => response.ok && ((await response.json()) as PingWakeResult).waking,
    ),
  PING_WAKE_EVERY_MS,
)

/** Whether its owner's play for today is used up: then no ping or join wakes it before midnight. */
const usedUp = (route: EdgeRoutes['routes'][number] | undefined): string | null =>
  route?.backAt !== undefined && Date.parse(route.backAt) > Date.now() ? route.backAt : null

/**
 * What a ping to a sleeping server is told: its own message and picture, and that a join wakes it,
 * or that it is waking already; or, while its owner's play for today is used up, when it is back.
 */
function asleep(address: string): NoticeText {
  const name = hostnameOf({ address })
  const route = routes.find((r) => r.hostname === name)
  const icon = route?.icon === undefined ? undefined : icons.get(route.icon)
  const backAt = usedUp(route)
  const waking = route?.waking === true || pingWakes.waking(name)
  const status =
    backAt !== null ? usedToday(backAt) : asleepMessage(route?.motd, waking ? WAKING_MOTD : ASLEEP.status)
  return { ...ASLEEP, status, ...(icon ? { icon } : {}), ...(route?.joins ? { joins: route.joins } : {}) }
}

/**
 * A ping is often the moment before a join: for a sleeping server that isn't waking yet, the
 * control plane may start it now, and the ping, answered once it has said or a moment has passed,
 * says it is waking. Which servers it starts, by where the ping came from (`address`, null when no
 * PROXY header said), is the control plane's to decide.
 */
async function pinged(hostname: string, address: string | null): Promise<void> {
  const route = routes.find((r) => r.hostname === hostname)
  if (route?.state !== 'asleep' || route.waking === true || usedUp(route) !== null) return
  await Promise.race([pingWakes.ask(hostname, address), Bun.sleep(PING_WAKE_WAIT_MS)])
}

/** Who a connection is from, by the PROXY header it came with; null without one. */
function sourceOf(header: Uint8Array | null): string | null {
  const read = header === null ? null : readProxyHeader(header)
  return read !== null && typeof read === 'object' ? (read.source?.address ?? null) : null
}

/**
 * Tells a ping at `address` that its server sleeps, and hands a join on to `then`, with the PROXY
 * header it came with, if any.
 */
function asleepAt(
  address: string,
  then: (client: Socket, join: Join, header: Uint8Array | null) => void,
): void {
  createServer((client) => {
    const notice = new Notice(asleep)
    const unwrap = new Unwrap()
    client.setTimeout(10_000, () => client.destroy())
    client.on('error', () => client.destroy())
    const answer = (own: Uint8Array) => {
      const { reply, close, join } = notice.receive(own)
      for (const bytes of reply) client.write(bytes)
      if (close) client.end()
      if (!join) return
      client.off('data', receive)
      client.setTimeout(0)
      then(client, join, unwrap.header)
    }
    // What came before the handshake was whole, held until it says whether this is a ping.
    let held: Uint8Array | null = new Uint8Array(0)
    /** The handshake is whole: a ping is answered once its server may have been woken, in order. */
    const greeted = (ping: string | null, sent: Uint8Array) => {
      held = null
      if (ping === null) return answer(sent)
      client.pause()
      void pinged(hostnameOf({ address: ping }), sourceOf(unwrap.header)).finally(() => {
        answer(sent)
        client.resume()
      })
    }
    const receive = (chunk: Buffer) => {
      const own = unwrap.take(chunk)
      if (own === 'bad') return void client.destroy()
      if (own === null) return
      if (held === null) return answer(own)
      held = Buffer.concat([held, own])
      const ping = pingOf(held)
      if (ping !== 'more') greeted(ping, held)
    }
    client.on('data', receive)
  }).listen(Number(address.split(':')[1]), '127.0.0.1')
}

asleepAt(SLEEPING, passOn)

// ─── The waiting room ────────────────────────────────────────────────────────────────────────

// Every join to a server that isn't running comes here at once (`wake`). It wakes the server and
// holds the player meanwhile, speaking to their client every few seconds so it keeps waiting, then
// connects them as if they had just dialled it. A player's first join after a sleep gets in; only
// one that can't is turned away, with why.

/** Holds `join` until its server is up, then passes it on; or turns it away, saying why. */
async function hold(client: Socket, join: Join, header: Uint8Array | null): Promise<void> {
  const held = new Held(join)
  client.on('data', (chunk: Buffer) => {
    if (!held.receive(chunk)) client.destroy()
  })
  // A client from before 1.13 can't be spoken to while it waits, so it waits only as long as it would.
  const speaks = join.protocol >= LOGIN_QUERIES
  const keepAlive = speaks ? setInterval(() => client.write(held.ask()), 10_000) : undefined
  const result = await wakeWhile(client, hostnameOf(join), Date.now() + (speaks ? HOLD_MS : 0)).finally(() =>
    clearInterval(keepAlive),
  )
  if (client.destroyed) return
  if (result?.outcome === 'ready' && (await settle(client, held))) {
    client.removeAllListeners('data')
    pipe(
      client,
      result.destination,
      forServer(result.proxyProtocol === true, header, held.replay()),
      TIMEOUTS,
    )
    return
  }
  const backAt = result?.outcome === 'denied' ? result.backAt : undefined
  client.end(turnAway(backAt === undefined ? TURNED_AWAY[whyNot(result)] : usedToday(backAt)))
}

/** Asks for the wake until the server is up, is refused, the client leaves, or `deadline` passes. */
async function wakeWhile(client: Socket, hostname: string, deadline: number): Promise<WakeResult | null> {
  for (;;) {
    const result = await wakeOnce(hostname).catch(() => null)
    const over = result?.outcome === 'ready' || result?.outcome === 'denied'
    if (over || client.destroyed || Date.now() >= deadline) return result
    await Bun.sleep(2_000)
  }
}

/** Waits for the client to answer the hold's last queries, which the server must never get. */
async function settle(client: Socket, held: Held): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (!held.settled && !client.destroyed && Date.now() < deadline) await Bun.sleep(50)
  return held.settled && !client.destroyed
}

/** Why a held join can't go on, as the player is told it; null is a control plane that didn't answer. */
function whyNot(result: WakeResult | null): keyof typeof TURNED_AWAY {
  if (result === null) return 'unreachable'
  if (result.outcome === 'denied') return result.reason
  if (result.outcome === 'starting') return result.behind ?? 'starting'
  return result.outcome === 'restarting' ? 'restarting' : 'starting'
}

asleepAt(WAITING, (client, join, header) => void hold(client, join, header))

// ─── Supervise mc-router ────────────────────────────────────────────────────────────────────

const child = Bun.spawn(
  [
    env('ROUTER_BIN', '/mc-router'),
    '-port',
    String(ROUTER_PORT),
    // Only the front door connects, and says who it connects for in a PROXY header, which
    // mc-router passes on to the server: every connection but one to a server that reads none.
    '-dynamic-proxy-protocol',
    '-trusted-proxies',
    '127.0.0.1/32',
    // Routes come and go one at a time through the API (router.ts), never from a file read whole.
    '-api-binding',
    ROUTER_API,
    '-auto-scale-webhook-url',
    `http://127.0.0.1:${AGENT_PORT}/scale`,
    '-auto-scale-webhook-timeout',
    '60s',
    '-auto-scale-webhook-wake-timeout',
    '60s',
    '-auto-scale-down-after',
    env('IDLE_HINT_AFTER', '10m'),
    '-auto-scale-asleep-motd',
    ASLEEP.status,
    '-auto-scale-loading-motd',
    env('LOADING_MOTD', 'Starting up · try again in a moment'),
    '-webhook-url',
    `http://127.0.0.1:${AGENT_PORT}/session`,
    '-connection-rate-limit',
    env('CONNECTION_RATE_LIMIT', '1000'),
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))

/** Polls for routes for good. A list just applied is said to be held at once, by asking again. */
async function pollRoutes(): Promise<never> {
  for (;;) {
    if (!(await syncRoutes())) await Bun.sleep(POLL_MS)
    fetchIcons()
  }
}

// Players are let in only once mc-router holds every route: until then, one would be closed.
await router.ready(30_000)
while (!(await syncRoutes())) await Bun.sleep(POLL_MS)
void pollRoutes()

front({
  port: MINECRAFT_PORT,
  router: ROUTER_PORT,
  proxied: env('PROXY_PROTOCOL', '') === '1',
  gate: new Gate(LIMITS),
  known: (name) => hostnames.has(name),
  plain: (name) => plain.has(name),
  busy: env('BUSY_JOIN', 'This server is busy right now · join again in a moment'),
  refuse: (name, protocol) => {
    const joins = routes.find((r) => r.hostname === name)?.joins
    return joins === undefined || takes(joins, protocol) ? null : wrongGame(joins, protocol, releases)
  },
  timeouts: TIMEOUTS,
})

const code = await child.exited
console.error(`mc-router exited with ${code}`)
process.exit(code || 1)
