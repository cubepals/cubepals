// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The half of `scripts/players-bench.ts` that runs inside Fly, beside the server it loads. One
 * `load` job builds the arenas over the console, brings players in by steps, and at each step
 * reads the server's tick times, CPU and heap for a few minutes; `bots` jobs, which it starts, are
 * the players, a share each, so one process's event loop never holds them all back.
 *
 *   bun probe.js load <host> <name> <counts, e.g. 25,50,100> <minutes per step>
 *   bun probe.js bots <host> <first> <count>
 *   bun probe.js join <address> <name> [version] [seconds] [stay]
 *
 * A player is put in an arena by number, ten to each, and fights whoever is nearest: it looks at
 * them, runs at them, jumps and strafes now and then, and swings when close, about four times a
 * second, as a player clicking does. Two in fifty queue for the Duels plugin's own arena instead.
 * Each result is one JSON line on stdout; it needs RCON_PASSWORD. Not for anything but the bench:
 * it trusts its arguments.
 *
 * `join` is one player's join through the edge, timed as the player feels it: the server list's
 * ping and its line, then the connection, the login answered, the configuration done and the
 * player in the world, with what the list said each second while the join was held, and the
 * reason if the join was turned away. It stays in the world `stay` seconds (none by default) before
 * it leaves. It needs no console.
 */
import { readFileSync, writeSync } from 'node:fs'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { GAME_PORT } from '../../apps/control/src/minecraft/ports.ts'
import { rcon } from './rcon.ts'

/** As much of mineflayer as the probe uses; it is installed on the probe's machine, not here. */
interface Vec {
  x: number
  y: number
  z: number
  distanceTo(other: Vec): number
  offset(x: number, y: number, z: number): Vec
}
interface Entity {
  type: string
  height: number
  position: Vec
}
interface Bot {
  entity: Entity | undefined
  nearestEntity(match: (entity: Entity) => boolean): Entity | null
  lookAt(at: Vec, force: boolean): Promise<void>
  look(yaw: number, pitch: number, force: boolean): Promise<void>
  setControlState(control: 'forward' | 'sprint' | 'jump' | 'left' | 'right', on: boolean): void
  attack(entity: Entity): void
  chat(text: string): void
  on(event: 'spawn', listener: () => void): void
  on(event: 'messagestr', listener: (text: string) => void): void
  on(event: 'error' | 'kicked' | 'end', listener: (reason: unknown) => void): void
  removeListener(event: 'messagestr', listener: (text: string) => void): void
}
interface Mineflayer {
  createBot(options: {
    host: string
    port: number
    username: string
    auth: 'offline'
    hideErrors: boolean
    version?: string
  }): Bot
}
/** As much of minecraft-protocol, mineflayer's own, as `join` uses: the server list's ping. */
interface Protocol {
  ping(options: { host: string; port: number; version: string; closeTimeout: number }): Promise<{
    description: unknown
    latency: number
    version?: { name: string; protocol: number }
  }>
}
/** The client under a bot, for the moments of a join mineflayer doesn't name. */
interface Wire {
  on(event: 'connect', listener: () => void): void
  on(event: 'state', listener: (state: string) => void): void
  on(event: 'encryption_begin' | 'compress' | 'success', listener: () => void): void
}
// By a name in a variable, so nothing here resolves it before it runs where it is installed.
const MINEFLAYER = 'mineflayer'
const PROTOCOL = 'minecraft-protocol'

/** Players to an arena, and to a `bots` process. */
const PER_ARENA = 10
const PER_PROCESS = 25
/** Arenas sit this far apart on x, the first at ARENA_GAP: Duels' own platform is at the origin. */
const ARENA_GAP = 100
/** A swing at most this often, about what a player clicking manages. */
const SWING_MS = 250
/**
 * One join from a probe at most this often. Every player comes from its one address, which
 * Bukkit's connection throttle would let in once every 4 s; the bench turns it off on its servers
 * (`players-bench.ts`), and joins are spaced as a crowd arriving would be.
 */
const JOIN_MS = 500
/** The player that asks spark how the process is: spark answers the console later than RCON waits. */
const EYE = 'BenchEye'
/** How often the bench reads the server during a step, and how long a step settles first. */
const SAMPLE_MS = 10_000
const SETTLE_MS = MINUTE_MS

const emit = (record: Record<string, unknown>): void =>
  void writeSync(1, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** Minecraft's colour codes out of a console reply. */
const plain = (text: string) => text.replace(/§./g, '')
const numbers = (text: string) =>
  (
    plain(text)
      .split(':')
      .slice(1)
      .join(':')
      .match(/\d+(\.\d+)?/g) ?? []
  ).map(Number)

/** The console answering, which it does once the world is loaded. */
async function untilConsole(host: string): Promise<void> {
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    try {
      await rcon(host, 'list')
      return
    } catch {
      await Bun.sleep(2000)
    }
  }
  throw new Error(`no console on ${host} in 10 minutes`)
}

/** The x of an arena's corner; the arena is the void world's platform shape, 33 blocks square. */
const arenaX = (arena: number) => arena * ARENA_GAP

/**
 * Arenas for the largest step, each the platform Duels' own stands on, walled with barrier so a
 * fight never ends in the void; and the rules a long fight needs: kits kept, an instant respawn.
 */
async function prepare(host: string, players: number): Promise<void> {
  for (const command of [
    'whitelist off',
    'gamerule keepInventory true',
    'gamerule doImmediateRespawn true',
    'gamerule announceAdvancements false',
  ])
    await rcon(host, command)
  for (let arena = 1; arena <= Math.ceil(players / PER_ARENA); arena++) {
    const x = arenaX(arena)
    await rcon(host, `forceload add ${x - 9} -9 ${x + 25} 25`)
    await rcon(host, `fill ${x - 8} -61 -8 ${x + 24} -61 24 minecraft:stone`)
    await rcon(host, `fill ${x - 9} -60 -9 ${x + 25} -57 25 minecraft:barrier hollow`)
    await rcon(host, `forceload remove ${x - 9} -9 ${x + 25} 25`)
  }
}

/** Players online, as the console counts them. */
const online = async (host: string) =>
  Number(/There are (\d+)/.exec(plain(await rcon(host, 'list')))?.[1] ?? 0)

/** The observer: a spectator at spawn, an operator, so it may ask spark. */
async function observer(mineflayer: Mineflayer, host: string): Promise<Bot> {
  const eye = mineflayer.createBot({
    host,
    port: GAME_PORT,
    username: EYE,
    auth: 'offline',
    hideErrors: true,
  })
  await new Promise<void>((resolve) => eye.on('spawn', resolve))
  await rcon(host, `op ${EYE}`)
  await rcon(host, `gamemode spectator ${EYE}`)
  return eye
}

/** What spark says of the process's CPU and memory, as the observer reads it in chat. */
async function health(eye: Bot): Promise<string> {
  const lines: string[] = []
  const take = (text: string) => void lines.push(text)
  eye.on('messagestr', take)
  eye.chat('/spark health --memory')
  await Bun.sleep(3000)
  eye.removeListener('messagestr', take)
  return lines.join('\n')
}

/** "455.5 MB" or "2.0 GB" in MB. */
const mb = (amount: string | undefined, unit: string | undefined) =>
  Number(amount ?? 0) * (unit === 'GB' ? 1024 : unit === 'KB' ? 1 / 1024 : 1)

/**
 * spark's report in numbers: the ticks of the last 10 s (median, 95th percentile, longest, in
 * ms), the CPU of the last minute (the process and the machine, in % of all its cores), the heap
 * in use and committed, and the old generation as the last collection left it: what the server
 * holds on to.
 */
function sparkOf(report: string) {
  const ticks = /Tick durations[^\n]*\n\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(report)
  const cpu = /CPU usage[^\n]*\n\s*[\d.]+%, ([\d.]+)%[^\n]*\n\s*[\d.]+%, ([\d.]+)%/.exec(report)
  const heap = /Memory usage:\n\s*([\d.]+) (\w+) \/ ([\d.]+) (\w+)/.exec(report)
  const old = /Old Gen pool usage:[\s\S]*?Usage at last GC: ([\d.]+) (\w+)/.exec(report)
  return {
    tickMedian: Number(ticks?.[2] ?? 0),
    tick95: Number(ticks?.[3] ?? 0),
    tickMax: Number(ticks?.[4] ?? 0),
    cpuSystem: Number(cpu?.[1] ?? 0),
    cpuProcess: Number(cpu?.[2] ?? 0),
    heapMb: mb(heap?.[1], heap?.[2]),
    heapCommittedMb: mb(heap?.[3], heap?.[4]),
    oldAfterGcMb: mb(old?.[1], old?.[2]),
  }
}

/** One reading: Paper's tick times and TPS, spark's view of the process, and the probe's own load. */
async function sample(host: string, eye: Bot) {
  const [mspt, tps, spark, players] = await Promise.all([
    rcon(host, 'mspt'),
    rcon(host, 'tps'),
    health(eye),
    online(host),
  ])
  // avg/min/max over the last 5 s, 10 s and minute.
  const [, , max5s = 0, avg10s = 0, , max10s = 0, avg1m = 0, , max1m = 0] = numbers(mspt)
  const [tps1m = 0] = numbers(tps)
  // The probe's own 1-minute load: past its four cores, its players lag, not the server.
  const probeLoad = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0])
  return { players, avg10s, max10s, max5s, avg1m, max1m, tps1m, ...sparkOf(spark), probeLoad }
}

const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

/**
 * The steps: players brought in a process at a time, since one address joins only so fast, until
 * the step's count is online with the observer; a minute to settle; then readings.
 */
async function load(host: string, name: string, counts: readonly number[], minutes: number): Promise<void> {
  const mineflayer = ((await import(MINEFLAYER)) as { default: Mineflayer }).default
  await untilConsole(host)
  await prepare(host, Math.max(...counts))
  const eye = await observer(mineflayer, host)
  const processes: ReturnType<typeof Bun.spawn>[] = []
  let players = 0
  for (const count of counts) {
    while (1 + players < count) {
      const share = Math.min(PER_PROCESS, count - 1 - players)
      const args = ['bun', process.argv[1] ?? '', 'bots', host, String(players), String(share)]
      processes.push(Bun.spawn(args, { stdout: 'ignore', stderr: 'inherit' }))
      players += share
      const deadline = Date.now() + 600_000
      while ((await online(host)) < 1 + players && Date.now() < deadline) await Bun.sleep(5000)
    }
    emit({ job: 'step', name, count, joined: await online(host) })
    await Bun.sleep(SETTLE_MS)
    const samples: Awaited<ReturnType<typeof sample>>[] = []
    for (let i = 0; i < (minutes * MINUTE_MS) / SAMPLE_MS; i++) {
      const reading = await sample(host, eye).catch((error: unknown) => ({ error: messageOf(error) }))
      emit({ job: 'sample', name, count, ...reading })
      if (!('error' in reading)) samples.push(reading)
      await Bun.sleep(SAMPLE_MS)
    }
    emit({
      job: 'summary',
      name,
      count,
      players: median(samples.map((s) => s.players)),
      msptMedian: median(samples.map((s) => s.avg10s)),
      msptWorst10s: Math.max(...samples.map((s) => s.avg10s)),
      tickWorst: Math.max(...samples.map((s) => s.max10s)),
      tpsLeast: Math.min(...samples.map((s) => s.tps1m)),
      sparkTickMedian: median(samples.map((s) => s.tickMedian)),
      sparkTick95Worst: Math.max(...samples.map((s) => s.tick95)),
      sparkTickMax: Math.max(...samples.map((s) => s.tickMax)),
      cpuProcessMost: Math.max(...samples.map((s) => s.cpuProcess)),
      heapMostMb: Math.max(...samples.map((s) => s.heapMb)),
      oldAfterGcMostMb: Math.max(...samples.map((s) => s.oldAfterGcMb)),
      probeLoadMost: Math.max(...samples.map((s) => s.probeLoad)),
    })
  }
  for (const running of processes) running.kill()
}

/** This process's joins, one at a time, each JOIN_MS after the one before. */
let gate: Promise<void> = Promise.resolve()
const turn = (): Promise<void> => {
  gate = gate.then(() => Bun.sleep(JOIN_MS))
  return gate
}

/** One player: in its arena with a kit at every spawn, fighting whoever is nearest, back if it drops. */
async function player(mineflayer: Mineflayer, host: string, index: number): Promise<void> {
  const username = `Bench${index}`
  await turn()
  const bot = mineflayer.createBot({ host, port: GAME_PORT, username, auth: 'offline', hideErrors: true })
  const duels = index % 50 < 2
  let lastSwing = 0
  let strafe: 'left' | 'right' = 'left'
  let kitted = false
  bot.on('spawn', () => {
    void (async () => {
      if (!kitted) {
        kitted = true
        for (const [slot, item] of [
          ['weapon.mainhand', 'iron_sword'],
          ['armor.head', 'iron_helmet'],
          ['armor.chest', 'iron_chestplate'],
          ['armor.legs', 'iron_leggings'],
          ['armor.feet', 'iron_boots'],
        ])
          await rcon(host, `item replace entity ${username} ${slot} with minecraft:${item}`)
      }
      if (duels) return bot.chat('/duels join')
      const x = arenaX(1 + Math.floor(index / PER_ARENA)) + Math.random() * 32 - 8
      await rcon(host, `tp ${username} ${x.toFixed(1)} -60 ${(Math.random() * 32 - 8).toFixed(1)}`)
    })().catch((error: unknown) => process.stderr.write(`${username}: ${messageOf(error)}\n`))
  })
  const fight = setInterval(() => {
    const self = bot.entity
    if (self === undefined) return
    const target = bot.nearestEntity((e) => e.type === 'player')
    if (target === null) {
      bot.setControlState('forward', true)
      if (Math.random() < 0.05) void bot.look(Math.random() * 2 * Math.PI, 0, true)
      return
    }
    const distance = self.position.distanceTo(target.position)
    void bot.lookAt(target.position.offset(0, target.height, 0), true)
    bot.setControlState('forward', distance > 2)
    bot.setControlState('sprint', distance > 2)
    bot.setControlState('jump', Math.random() < 0.1)
    if (Math.random() < 0.05) {
      bot.setControlState(strafe, false)
      strafe = strafe === 'left' ? 'right' : 'left'
      bot.setControlState(strafe, true)
    }
    if (distance < 3.5 && Date.now() - lastSwing > SWING_MS) {
      bot.attack(target)
      lastSwing = Date.now()
    }
  }, 100)
  const requeue = duels ? setInterval(() => bot.chat('/duels join'), 20_000) : undefined
  bot.on('error', () => {})
  bot.on('kicked', (reason) => process.stderr.write(`${username} kicked: ${JSON.stringify(reason)}\n`))
  bot.on('end', () => {
    clearInterval(fight)
    clearInterval(requeue)
    void player(mineflayer, host, index)
  })
}

async function bots(host: string, first: number, count: number): Promise<void> {
  const mineflayer = ((await import(MINEFLAYER)) as { default: Mineflayer }).default
  for (let index = first; index < first + count; index++) void player(mineflayer, host, index)
  // The players run until the load job ends this process.
  await new Promise(() => {})
}

/** A chat component as the list shows it, colours and all left out: its text and its extras'. */
function textOf(component: unknown): string {
  if (typeof component === 'string') return plain(component)
  if (component === null || typeof component !== 'object') return ''
  const { text = '', extra = [] } = component as { text?: string; extra?: unknown[] }
  return plain(String(text)) + extra.map(textOf).join('')
}

/**
 * One join, timed from the moment it connects: the list's line first, then each step of the
 * login, and the list's line each second while the join waits, as a friend's list beside it
 * would show it.
 */
async function joinOnce(
  address: string,
  name: string,
  version: string,
  seconds: number,
  stay: number,
): Promise<void> {
  const mineflayer = ((await import(MINEFLAYER)) as { default: Mineflayer }).default
  const protocol = ((await import(PROTOCOL)) as { default: Protocol }).default
  const ping = () => protocol.ping({ host: address, port: GAME_PORT, version, closeTimeout: 5000 })
  const before = await ping().then(
    (answer) => ({ ms: answer.latency, line: textOf(answer.description), version: answer.version?.name }),
    (error: unknown) => ({ error: messageOf(error) }),
  )
  const started = Date.now()
  const since = () => Date.now() - started
  const steps: Record<string, number> = {}
  const lines: { ms: number; line: string }[] = []
  let over = false
  const watch = async () => {
    while (!over) {
      const answer = await ping().catch(() => undefined)
      const line = answer === undefined ? '' : textOf(answer.description)
      if (!over && line !== '' && line !== lines.at(-1)?.line) lines.push({ ms: since(), line })
      await Bun.sleep(1000)
    }
  }
  const bot = mineflayer.createBot({
    host: address,
    port: GAME_PORT,
    username: name,
    auth: 'offline',
    hideErrors: true,
    version,
  })
  const wire = (bot as unknown as { _client: Wire })._client
  const mark = (step: string) => {
    if (steps[step] === undefined) steps[step] = since()
  }
  wire.on('connect', () => mark('connected'))
  wire.on('state', mark)
  // The server's first answer to the login: it is up and has the player. A server that checks
  // accounts asks for encryption here, which a player with no account can't give, so on such a
  // server this is as far as the join is timed.
  for (const first of ['encryption_begin', 'compress', 'success'] as const)
    wire.on(first, () => mark('answered'))
  void watch()
  const ended = await new Promise<{ kicked?: string; error?: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ error: `not in the world in ${seconds}s` }), seconds * 1000)
    bot.on('spawn', () => {
      mark('spawned')
      clearTimeout(timer)
      resolve({})
    })
    bot.on('kicked', (reason) => {
      clearTimeout(timer)
      resolve({ kicked: textOf(typeof reason === 'string' ? safeJson(reason) : reason) })
    })
    bot.on('error', (error) => {
      clearTimeout(timer)
      resolve({ error: messageOf(error) })
    })
  })
  over = true
  emit({ job: 'join', address, name, version, before, steps, lines, ...ended })
  if (ended.kicked === undefined && ended.error === undefined) await Bun.sleep(stay * 1000)
  ;(bot as unknown as { quit(): void }).quit()
}

/** A kick's reason, which arrives as JSON text or as plain text. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const [job = '', host = '', a = '', b = '', c = '', d = ''] = process.argv.slice(2)
try {
  if (job === 'load') await load(host, a, b.split(',').map(Number), Number(c))
  else if (job === 'bots') await bots(host, Number(a), Number(b))
  else if (job === 'join') await joinOnce(host, a, b || '1.21.11', Number(c || 240), Number(d || 0))
  else throw new Error(`no job ${job}`)
  process.exit(0)
} catch (error) {
  emit({ job, host, error: messageOf(error) })
  process.exit(1)
}
