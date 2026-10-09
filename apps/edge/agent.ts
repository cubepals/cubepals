// The edge agent: the only code that knows mc-router exists. It turns the control plane's edge
// protocol (routes, wake, idle, sessions) into mc-router's routes file and webhooks, and
// supervises mc-router itself. Replacing mc-router means rewriting this file, nothing else.

import { renameSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { hostname } from 'node:os'
import type { EdgeRoutes, SessionEvent, WakeResult } from '@blockly/contracts/edge'
import type { Subprocess } from 'bun'
import { Held, LOGIN_QUERIES, turnAway } from './hold.ts'
import { mappings } from './mappings.ts'
import { type Join, Notice, type NoticeText, statusRequest } from './notice.ts'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

const CONTROL_URL = env('CONTROL_URL').replace(/\/$/, '')
const TOKEN = env('EDGE_TOKEN')
const EDGE_ID = env('EDGE_ID', hostname())
const ROUTES_FILE = env('ROUTES_FILE', '/tmp/routes.json')
const AGENT_PORT = Number(env('AGENT_PORT', '8090'))
// Routes are what the router knows about a hostname, and a player joins a world the moment it
// comes up, so this is short on purpose: every poll but the first is an ETag 304.
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
/** Where a join goes that has to wait for its server: the agent's waiting room, which wakes it. */
const WAITING = `127.0.0.1:${env('WAITING_PORT', '25562')}`
/** How long the waiting room holds a join for its server to come up, before asking for another try. */
const HOLD_MS = Number(env('WAKE_HOLD_MS', '180000'))
/** What a held join is told when it can't go on, by why. Every one of them reaches a player. */
const TURNED_AWAY = {
  starting: env('STILL_STARTING_JOIN', 'Still starting · join again in a moment'),
  restarting: RESTARTING.join,
  unreachable: env('UNREACHABLE_JOIN', 'Couldn’t start this server just now · join again in a moment'),
  unknown: env('UNKNOWN_JOIN', 'There’s no Cubepals server at this address'),
  deleted: env('DELETED_JOIN', 'This server was deleted'),
  paused: env('PAUSED_JOIN', 'Cubepals isn’t starting servers right now · try again soon'),
  suspended: env('REFUSED_JOIN', 'This server can’t start right now · its owner can see why on Cubepals'),
  quota: env('REFUSED_JOIN', 'This server can’t start right now · its owner can see why on Cubepals'),
} as const

const control = (path: string, init: RequestInit = {}) =>
  fetch(`${CONTROL_URL}/edge/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(30_000),
  })

// ─── Routes: pulled, so every edge machine converges and a restart loses nothing ────────────

let etag: string | null = null
/** mc-router, once it runs. */
let router: Subprocess | null = null
/** What the control plane last said. */
let routes: EdgeRoutes['routes'] = []
/**
 * Destinations of running servers that didn't answer: restarting without Blockly asking, as when
 * the provider brings a crashed one back. Their players are told so until they answer again.
 */
const unreachable = new Set<string>()
/** When each running server was last asked whether it answers. */
const asked = new Map<string, number>()

function writeRoutes(): void {
  const table = mappings(routes, unreachable, { restarting: NOTICE, asleep: SLEEPING })
  const temporary = `${ROUTES_FILE}.tmp`
  writeFileSync(temporary, JSON.stringify({ 'default-server': null, mappings: table }, null, 2))
  renameSync(temporary, ROUTES_FILE)
  // mc-router's own file watch follows the inode this rename replaces, so it stops after the first
  // update, and it only ever adds routes. SIGHUP rereads the file by path and replaces them all.
  router?.kill('SIGHUP')
}

async function syncRoutes(): Promise<void> {
  try {
    const response = await control('/routes', { headers: etag ? { 'if-none-match': etag } : {} })
    if (response.status === 304) return
    if (!response.ok) throw new Error(`routes answered ${response.status}`)
    routes = ((await response.json()) as EdgeRoutes).routes
    const running = new Set(routes.filter((r) => r.state === undefined).map((r) => r.destination))
    for (const destination of unreachable) if (!running.has(destination)) unreachable.delete(destination)
    for (const destination of asked.keys()) if (!running.has(destination)) asked.delete(destination)
    writeRoutes()
    etag = response.headers.get('etag')
  } catch (error) {
    console.error('route sync failed; keeping the last known routes', error)
  }
}

// ─── Running servers that don't answer, watched until they do ──────────────────────────────

/** Whether the server at `destination` answers a status request, as a player's server list asks. */
function answers(destination: string): Promise<boolean> {
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
    socket.once('connect', () => socket.write(statusRequest(host, port)))
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
  writeRoutes()
}

setInterval(async () => {
  let changed = false
  for (const destination of unreachable) {
    if (!(await answers(destination))) continue
    unreachable.delete(destination)
    changed = true
  }
  if (changed) writeRoutes()
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
  if (!unreachable.has(result.destination) && !(await answers(result.destination))) {
    unreachable.add(result.destination)
    writeRoutes()
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
  const asked = control('/wake', { method: 'POST', body: JSON.stringify({ hostname }) })
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

Bun.listen<Notice>({
  hostname: '127.0.0.1',
  port: Number(NOTICE.split(':')[1]),
  socket: {
    open(socket) {
      socket.data = new Notice(RESTARTING)
      socket.timeout(10)
    },
    data(socket, chunk) {
      const { reply, close } = socket.data.receive(chunk)
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

/** The hostname a join dialled, as mc-router reads it: before any Forge or proxy suffix, lowercased, no root dot. */
const hostnameOf = (join: Join): string =>
  (join.address.split('\0')[0] ?? '').split('\\')[0]?.toLowerCase().replace(/\.$/, '') ?? ''

/** Connects a join handed back by the notice to the server its address routes to. */
function passOn(client: Socket, join: Join): void {
  const route = routes.find((r) => r.hostname === hostnameOf(join))
  if (!route) {
    client.destroy()
    return
  }
  pipe(client, route.destination, join.bytes)
}

/** Connects `client` to the server at `destination`, which first gets what the client sent so far. */
function pipe(client: Socket, destination: string, sent: Uint8Array): void {
  const colon = destination.lastIndexOf(':')
  const server = connect({
    host: destination.slice(0, colon).replace(/^\[|\]$/g, ''),
    port: Number(destination.slice(colon + 1)),
  })
  server.write(sent)
  client.pipe(server).pipe(client)
  client.once('close', () => server.destroy())
  server.once('close', () => client.destroy())
  client.once('error', () => server.destroy())
  server.once('error', () => client.destroy())
}

/** Tells a ping at `address` that its server sleeps, and hands a join on to `then`. */
function asleepAt(address: string, then: (client: Socket, join: Join) => void): void {
  createServer((client) => {
    const notice = new Notice(ASLEEP)
    client.setTimeout(10_000, () => client.destroy())
    client.on('error', () => client.destroy())
    const receive = (chunk: Buffer) => {
      const { reply, close, join } = notice.receive(chunk)
      for (const bytes of reply) client.write(bytes)
      if (close) client.end()
      if (!join) return
      client.off('data', receive)
      client.setTimeout(0)
      then(client, join)
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
async function hold(client: Socket, join: Join): Promise<void> {
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
    pipe(client, result.destination, held.replay())
    return
  }
  client.end(turnAway(TURNED_AWAY[whyNot(result)]))
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
  return result.outcome === 'restarting' ? 'restarting' : 'starting'
}

asleepAt(WAITING, (client, join) => void hold(client, join))

// ─── Supervise mc-router ────────────────────────────────────────────────────────────────────

writeRoutes()
await syncRoutes()
setInterval(syncRoutes, POLL_MS)

const child = Bun.spawn(
  [
    env('ROUTER_BIN', '/mc-router'),
    '-port',
    env('MINECRAFT_PORT', '25565'),
    '-routes-config',
    ROUTES_FILE,
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
    env('CONNECTION_RATE_LIMIT', '10'),
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)

router = child

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
const code = await child.exited
console.error(`mc-router exited with ${code}`)
process.exit(code || 1)
