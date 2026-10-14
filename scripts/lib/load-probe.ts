// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The half of `scripts/load-test.ts` that runs inside Fly, on a probe machine of its own app in
 * `blockly-staging`, since the game port can't be reached from where the test is driven. It is a
 * small HTTP server the test reaches through `fly proxy`, and its jobs are players at the edge:
 *
 *   POST /jobs {kind: 'play', address, name, minutes}   a headless player (mineflayer) joins the
 *        server's own address, walks, chats, breaks and places blocks for `minutes`, and leaves
 *   POST /jobs {kind: 'join', address, name, timeoutMs} joins until it is in the world, timed, and leaves
 *   POST /jobs {kind: 'answer', address, name, timeoutMs}
 *        the game's handshake and login until the server answers (`minecraft.ts` `join`), for a
 *        server that checks accounts, which a headless player has none of
 *   GET /jobs/<id>   whether it is done, and what it found
 *   GET /load        the machine's load and the players it holds
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
  findBlock(options: { matching: (block: Block) => boolean; maxDistance: number }): Block | null
  canDigBlock(block: Block): boolean
  dig(block: Block): Promise<void>
  equip(item: Item, where: 'hand'): Promise<void>
  placeBlock(reference: Block, face: Vec): Promise<void>
  look(yaw: number, pitch: number, force: boolean): Promise<void>
  setControlState(control: 'forward' | 'jump' | 'sprint', on: boolean): void
  chat(text: string): void
  quit(): void
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
  }): Bot
}
// By names in variables, so nothing here resolves them before they run where they are installed.
const MINEFLAYER = 'mineflayer'
const VEC3 = 'vec3'
const mineflayer = async () => ((await import(MINEFLAYER)) as { default: Mineflayer }).default
const vec3 = async () => ((await import(VEC3)) as { Vec3: new (x: number, y: number, z: number) => Vec }).Vec3

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
  timeoutMs: number,
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
      checkTimeoutInterval: 60_000,
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
    bot.quit()
    await Bun.sleep(2000)
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
  const until = Date.now() + minutes * 60_000
  for (let turn = 0; !over && Date.now() < until; turn++) {
    try {
      await bot.look(Math.random() * 2 * Math.PI, 0, true)
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
      if (turn % 4 === 1) await breakAndPlace(bot, Vec3, done)
    } catch (error) {
      done.misses.push(messageOf(error))
    }
    await Bun.sleep(500)
  }
  return done
}

/** A solid block near the player broken, then put back on top of another, as a builder does. */
async function breakAndPlace(
  bot: Bot,
  Vec3: new (x: number, y: number, z: number) => Vec,
  done: Played,
): Promise<void> {
  const target = bot.findBlock({
    matching: (block) => block.boundingBox === 'block' && bot.canDigBlock(block),
    maxDistance: 4,
  })
  if (target === null) {
    done.misses.push('no block in reach to break')
    return
  }
  await bot.dig(target)
  done.dug++
  await Bun.sleep(800)
  const item = bot.inventory.items()[0]
  if (item === undefined) {
    done.misses.push(`nothing picked up from ${target.name} (${bot.game.gameMode})`)
    return
  }
  const below = bot.blockAt(target.position.offset(0, -1, 0))
  if (below === null || below.boundingBox !== 'block') {
    done.misses.push('nothing to place on')
    return
  }
  await bot.equip(item, 'hand')
  await bot.placeBlock(below, new Vec3(0, 1, 0))
  done.placed++
}

type Job =
  | { kind: 'play'; address: string; name: string; minutes: number; timeoutMs: number }
  | { kind: 'join'; address: string; name: string; timeoutMs: number }
  | { kind: 'answer'; address: string; name: string; timeoutMs: number }

const results = new Map<string, { done: boolean; result?: unknown; error?: string; attempts?: Attempt[] }>()
let players = 0

async function run(job: Job): Promise<unknown> {
  if (job.kind === 'answer')
    return { ms: await join({ host: job.address, port: GAME_PORT }, job.address, job.name, job.timeoutMs) }
  const { bot, ms, attempts } = await enter(job.address, job.name, job.timeoutMs)
  players++
  try {
    if (job.kind === 'join') return { ms, attempts }
    return { ms, attempts, ...(await play(bot, job.name, job.minutes)) }
  } finally {
    players--
    bot.quit()
  }
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
let next = 0
Bun.serve({
  port: 8080,
  hostname: '::',
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path === '/jobs') {
      const id = String(++next)
      results.set(id, { done: false })
      run((await request.json()) as Job).then(
        (result) => results.set(id, { done: true, result }),
        (error: unknown) =>
          results.set(id, {
            done: true,
            error: messageOf(error),
            attempts: (error as { attempts?: Attempt[] }).attempts ?? [],
          }),
      )
      return Response.json({ id })
    }
    const job = /^\/jobs\/(\d+)$/.exec(path)?.[1]
    if (job !== undefined) {
      const found = results.get(job)
      return found === undefined ? new Response('no such job', { status: 404 }) : Response.json(found)
    }
    if (path === '/load')
      return Response.json({ load: Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]), players })
    return new Response('not found', { status: 404 })
  },
})
