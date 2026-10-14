// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The half of `scripts/load-test.ts` that runs inside Fly, on a probe machine of its own app in
 * `blockly-staging`, since the game port can't be reached from where the test is driven. It is a
 * small HTTP server the test reaches through `fly proxy`, and its jobs are players at the edge:
 *
 *   PUT /jobs/<id> {kind: 'play', address, name, version, minutes}
 *        a headless player (mineflayer) joins the server's own address, walks, chats, breaks and
 *        places blocks for `minutes`, and leaves
 *   PUT /jobs/<id> {kind: 'join', address, name, version, timeoutMs, againMs}
 *        joins until it is in the world, timed, and leaves; `againMs` after each try turned away
 *   PUT /jobs/<id> {kind: 'abandon', address, name, version, afterMs}
 *        clicks Join and gives up `afterMs` later, as an impatient player does
 *   PUT /jobs/<id> {kind: 'answer', address, name, timeoutMs}
 *        the game's handshake and login until the server answers (`minecraft.ts` `join`), for a
 *        server that checks accounts, which a headless player has none of
 *   GET /jobs/<id>   whether it is done, and what it found
 *   GET /load        the machine's load and the players it holds
 *   GET /versions    the game versions its headless players speak
 *
 * A join turned away while a world wakes (the edge's "join again", or the connection dropped
 * before the world) is tried again, as a player clicks Join again; every attempt is counted and
 * kept with what ended it. With DATABASE_HOST set it also forwards port 5432 there, so the test
 * reaches staging's database the way it reaches this machine. Not for anything but the load
 * test: it trusts its callers.
 *
 *   bun probe.js serve
 */
import { readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { GAME_PORT } from '../../apps/control/src/minecraft/ports.ts'
import { join } from './minecraft.ts'

/** As much of mineflayer as the probe uses; it is installed on the probe's machine, not here. */
interface Vec {
  x: number
  y: number
  z: number
  offset(x: number, y: number, z: number): Vec
}
interface Block {
  name: string
  position: Vec
  boundingBox: string
}
interface Item {
  name: string
}
interface Bot {
  entity: { position: Vec } | undefined
  game: { gameMode: string }
  inventory: { items(): Item[] }
  blockAt(at: Vec): Block | null
  canDigBlock(block: Block): boolean
  dig(block: Block): Promise<void>
  equip(item: Item, where: 'hand'): Promise<void>
  placeBlock(reference: Block, face: Vec): Promise<void>
  look(yaw: number, pitch: number, force: boolean): Promise<void>
  setControlState(control: 'forward' | 'jump' | 'sprint', on: boolean): void
  chat(text: string): void
  end(reason?: string): void
  once(event: 'spawn', listener: () => void): void
  on(event: 'kicked' | 'end' | 'error', listener: (reason: unknown) => void): void
}
interface Mineflayer {
  createBot(options: {
    host: string
    port: number
    username: string
    auth: 'offline'
    hideErrors: boolean
    checkTimeoutInterval: number
    version: string
  }): Bot
}
// By names in variables, so nothing here resolves them before they run where they are installed.
const MINEFLAYER = 'mineflayer'
const VEC3 = 'vec3'
const MINECRAFT_DATA = 'minecraft-data'
const mineflayer = async () => ((await import(MINEFLAYER)) as { default: Mineflayer }).default
const vec3 = async () => ((await import(VEC3)) as { Vec3: new (x: number, y: number, z: number) => Vec }).Vec3

/** How long a player takes to join again after being turned away. */
const JOIN_AGAIN_MS = 5 * SECOND_MS

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** A kick's reason as the game sends it, a chat component or text, as plain words. */
const reasonOf = (reason: unknown) => (typeof reason === 'string' ? reason : JSON.stringify(reason))

/** One join: in the world, or what ended it first. */
interface Attempt {
  ms: number
  ended: string | null
}

/** Joins until the player is in the world or `timeoutMs` passes, as a player clicks Join again. */
async function enter(
  address: string,
  name: string,
  version: string,
  timeoutMs: number,
  againMs = JOIN_AGAIN_MS,
): Promise<{ bot: Bot; ms: number; attempts: Attempt[] }> {
  const { createBot } = await mineflayer()
  const started = Date.now()
  const attempts: Attempt[] = []
  while (Date.now() - started < timeoutMs) {
    const at = Date.now()
    const bot = createBot({
      host: address,
      port: GAME_PORT,
      username: name,
      auth: 'offline',
      hideErrors: true,
      checkTimeoutInterval: MINUTE_MS,
      // A player's game is the version it is: guessed from the edge's answer for a sleeping
      // server, it would be the edge's own.
      version,
    })
    const ended = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(`not in the world within ${timeoutMs / 1000}s`), timeoutMs)
      bot.once('spawn', () => {
        clearTimeout(timer)
        resolve(null)
      })
      bot.on('kicked', (reason) => resolve(`kicked: ${reasonOf(reason)}`))
      bot.on('error', (error) => resolve(`error: ${messageOf(error)}`))
      bot.on('end', (reason) => resolve(`ended: ${reasonOf(reason)}`))
    })
    attempts.push({ ms: Date.now() - at, ended })
    if (ended === null) return { bot, ms: Date.now() - started, attempts }
    // A version the player can't speak is no wait a second try ends.
    if (ended.includes('No data available for version')) throw Object.assign(new Error(ended), { attempts })
    bot.end()
    // A player reads why and clicks Join again a few seconds later; sooner, Bukkit's connection
    // throttle, which counts every join from the edge's one address, would turn each one away.
    await Bun.sleep(againMs)
  }
  throw Object.assign(new Error(`never in the world within ${timeoutMs / 1000}s`), { attempts })
}

/** What a player did in a few minutes of play. */
interface Played {
  walked: number
  chats: number
  dug: number
  placed: number
  /** What a game action answered when it didn't work: the game's, kept apart from the product's. */
  misses: string[]
  /** What ended the session before its time, if anything did. */
  dropped: string | null
}

/**
 * A game action given ACTION_MS: one the server never confirms (a block a lobby won't let break)
 * would otherwise hold the player past its minutes, and the whole run with it.
 */
const ACTION_MS = 30 * SECOND_MS
const within = <T>(action: Promise<T>, what: string): Promise<T> =>
  Promise.race([
    action,
    Bun.sleep(ACTION_MS).then(() => {
      throw new Error(`${what} never finished`)
    }),
  ])

/** Walking about, a word in chat now and then, a block broken and put back: a player's minutes. */
async function play(bot: Bot, name: string, minutes: number): Promise<Played> {
  const Vec3 = await vec3()
  const done: Played = { walked: 0, chats: 0, dug: 0, placed: 0, misses: [], dropped: null }
  let over = false
  bot.on('kicked', (reason) => {
    done.dropped ??= `kicked: ${reasonOf(reason)}`
    over = true
  })
  bot.on('end', (reason) => {
    done.dropped ??= `ended: ${reasonOf(reason)}`
    over = true
  })
  const until = Date.now() + minutes * MINUTE_MS
  for (let turn = 0; !over && Date.now() < until; turn++) {
    try {
      await within(bot.look(Math.random() * 2 * Math.PI, 0, true), 'looking about')
      bot.setControlState('forward', true)
      bot.setControlState('jump', Math.random() < 0.2)
      await Bun.sleep(1500 + Math.random() * 1500)
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
      done.walked++
      if (turn % 8 === 3) {
        bot.chat(`${name} here, ${['hi all', 'nice spot', 'over here', 'brb'][turn % 4]}`)
        done.chats++
      }
      if (turn % 4 === 1) await within(breakAndPlace(bot, Vec3, done), 'breaking and placing')
    } catch (error) {
      done.misses.push(messageOf(error))
    }
    await Bun.sleep(500)
  }
  return done
}

/** The ground beside the player broken, then put back where it was, as a builder does. */
async function breakAndPlace(
  bot: Bot,
  Vec3: new (x: number, y: number, z: number) => Vec,
  done: Played,
): Promise<void> {
  const at = bot.entity?.position
  if (at === undefined) return
  const target = bot.blockAt(at.offset(1, -1, 0))
  if (target === null || target.boundingBox !== 'block' || !bot.canDigBlock(target)) {
    done.misses.push(`nothing to break beside it (${target?.name ?? 'unloaded'})`)
    return
  }
  const below = bot.blockAt(target.position.offset(0, -1, 0))
  await bot.dig(target)
  done.dug++
  await Bun.sleep(800)
  const item = bot.inventory.items()[0]
  if (item === undefined) {
    done.misses.push(`nothing picked up from ${target.name} (${bot.game.gameMode})`)
    return
  }
  if (below === null || below.boundingBox !== 'block') {
    done.misses.push('nothing to place on')
    return
  }
  await bot.equip(item, 'hand')
  await bot.placeBlock(below, new Vec3(0, 1, 0))
  done.placed++
}

type Job =
  | { kind: 'play'; address: string; name: string; version: string; minutes: number; timeoutMs: number }
  | { kind: 'join'; address: string; name: string; version: string; timeoutMs: number; againMs?: number }
  | { kind: 'answer'; address: string; name: string; timeoutMs: number }
  | { kind: 'abandon'; address: string; name: string; version: string; afterMs: number }

const results = new Map<string, { done: boolean; result?: unknown; error?: string; attempts?: Attempt[] }>()
let players = 0

async function run(job: Job): Promise<unknown> {
  if (job.kind === 'answer')
    return { ms: await join({ host: job.address, port: GAME_PORT }, job.address, job.name, job.timeoutMs) }
  if (job.kind === 'abandon') return abandon(job.address, job.name, job.version, job.afterMs)
  const againMs = job.kind === 'join' ? job.againMs : undefined
  const { bot, ms, attempts } = await enter(job.address, job.name, job.version, job.timeoutMs, againMs)
  players++
  try {
    if (job.kind === 'join') return { ms, attempts }
    return { ms, attempts, ...(await play(bot, job.name, job.minutes)) }
  } finally {
    players--
    bot.end()
  }
}

/** A player who clicks Join and gives up `afterMs` later, before or after they are in. */
async function abandon(address: string, name: string, version: string, afterMs: number) {
  const { createBot } = await mineflayer()
  const bot = createBot({
    host: address,
    port: GAME_PORT,
    username: name,
    auth: 'offline',
    hideErrors: true,
    checkTimeoutInterval: MINUTE_MS,
    version,
  })
  let spawned = false
  bot.once('spawn', () => {
    spawned = true
  })
  bot.on('error', () => {})
  await Bun.sleep(afterMs)
  bot.end()
  return { left: spawned ? 'after getting in' : 'before getting in' }
}

/** Port 5432 forwarded to staging's database, for the test that reaches this machine. */
function forwardDatabase(host: string): void {
  createServer((client) => {
    const upstream = createConnection({ host, port: 5432 })
    client.pipe(upstream).pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  }).listen(5432, '::')
}

if (process.argv[2] !== 'serve') throw new Error('usage: bun probe.js serve')
const databaseHost = process.env.DATABASE_HOST
if (databaseHost) forwardDatabase(databaseHost)
Bun.serve({
  port: 8080,
  hostname: '::',
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const job = /^\/jobs\/([\w-]+)$/.exec(path)?.[1]
    // The caller names the job, so a request it sends again after its connection dropped starts
    // nothing twice.
    if (request.method === 'PUT' && job !== undefined) {
      if (!results.has(job)) {
        results.set(job, { done: false })
        run((await request.json()) as Job).then(
          (result) => results.set(job, { done: true, result }),
          (error: unknown) =>
            results.set(job, {
              done: true,
              error: messageOf(error),
              attempts: (error as { attempts?: Attempt[] }).attempts ?? [],
            }),
        )
      }
      return Response.json({ id: job })
    }
    if (job !== undefined) {
      const found = results.get(job)
      return found === undefined ? new Response('no such job', { status: 404 }) : Response.json(found)
    }
    // The game versions its headless players speak, as the protocol data it carries lists them.
    if (path === '/versions')
      return Response.json(
        ((await import(MINECRAFT_DATA)) as { supportedVersions: { pc: string[] } }).supportedVersions.pc,
      )
    if (path === '/load')
      return Response.json({ load: Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]), players })
    return new Response('not found', { status: 404 })
  },
})
