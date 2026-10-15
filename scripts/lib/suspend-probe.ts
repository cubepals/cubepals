// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The half of `scripts/suspend-bench.ts` that runs inside Fly, on a machine of its own, since the
 * game port can't be reached from a cloud session. Every time it reports comes from this one clock:
 * the Machines API call, the first status ping answered on the game port, a headless player
 * (mineflayer) spawned in the world, and RCON for the block that shows the world came back as it
 * was left.
 *
 *   bun probe.js <job> <machine id> [count]
 *   bun probe.js edge-join <hostname> [count]
 *   bun probe.js flow <template> <size> [cycles]
 *
 * Jobs on the bench's own machines: `cycles` (suspend and resume, `count` times), `suspend`,
 * `resume`, `cold` (a stop and a start), `drop-stop` and `drop-update` (an unsaved block, a
 * suspend, then the snapshot dropped by a stop or by a config update before the start), `flush`
 * (how long `save-all flush` takes); they need FLY_API_TOKEN, BENCH_APP and RCON_PASSWORD in its
 * environment. `edge-join` is a player joining a Cubepals server asleep by its address, through
 * the edge, as a person would: turned away while it wakes, joining again until they are in the
 * world, `count` times a second; it needs nothing else. `flow` is Cubepals' own sleep and wake on a
 * server of its own, through the control plane's Fly runtime this probe was built with; it needs
 * FLY_API_TOKEN. Each result is one JSON line on stdout. It runs as one bundle (`suspend-bench.ts`
 * builds it) with `mineflayer` installed beside it. Not for anything but the bench: it trusts its
 * arguments.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import { Socket } from 'node:net'
import { runtimeKey } from '../../apps/control/src/app/ports/runtime.ts'
import type { MemoryTier } from '../../apps/control/src/domain/server/size.ts'
import { flyClient } from '../../apps/control/src/infra/fly/client.ts'
import { FlyRuntime } from '../../apps/control/src/infra/fly/fly-runtime.ts'
import { GAME_PORT } from '../../apps/control/src/minecraft/ports.ts'
import { PORT_NAMES } from '../../apps/control/src/minecraft/runtime-spec.ts'
import { type BenchTemplate, configFor } from '../suspend-bench.ts'
import { join as answered, mcString, packet, varInt } from './minecraft.ts'
import { rcon } from './rcon.ts'

/** As much of mineflayer as the probe uses; it is installed on the probe's machine, not here. */
interface Bot {
  entity: { position: { constructor: new (x: number, y: number, z: number) => unknown } }
  blockAt(at: unknown): { name: string } | null
  waitForChunksToLoad(): Promise<void>
  end(): void
  once(event: 'spawn', listener: () => void): void
  once(event: 'error' | 'kicked' | 'end', listener: (reason: unknown) => void): void
}
interface Mineflayer {
  createBot(options: {
    host: string
    port: number
    username: string
    auth: 'offline'
    hideErrors: boolean
  }): Bot
}
// By a name in a variable, so nothing here resolves it before it runs where it is installed.
const MINEFLAYER = 'mineflayer'
const mineflayer = ((await import(MINEFLAYER)) as { default: Mineflayer }).default

/** The Machines API from inside Fly's network; a machine's own socket can't reach its neighbours. */
const API = `http://_api.internal:4280/v1/apps/${process.env.BENCH_APP}/machines`
const TOKEN = (process.env.FLY_API_TOKEN ?? '').trim()
const AUTH = /^(FlyV1|Bearer) /.test(TOKEN)
  ? TOKEN
  : /^fm[12]/.test(TOKEN)
    ? `FlyV1 ${TOKEN}`
    : `Bearer ${TOKEN}`
const BOT = 'BenchBot'
/** Where the bench's blocks go: above spawn, out of anything the world generates. */
const BLOCK_AT = { x: 0, y: 200, z: 0 }
const BLOCKS = ['gold_block', 'diamond_block', 'emerald_block', 'lapis_block', 'redstone_block']

type Machine = { state: string; private_ip: string; config: { metadata?: Record<string, string> } }

const now = () => performance.timeOrigin + performance.now()
/** One result line, written at once: a job runs for many minutes, and its lines are read as it goes. */
const emit = (record: Record<string, unknown>): void =>
  void writeSync(1, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function fly<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: AUTH, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status !== 429) break
    await Bun.sleep(1000)
  }
  if (response === undefined) throw new Error(`${method} ${path}: no answer`)
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
  return (text === '' ? null : JSON.parse(text)) as T
}

/**
 * When the machine reached `state`: Fly's own long poll, which answers as the machine gets there.
 * Polling its state instead runs into the API's rate limit (429) within a second.
 */
async function untilState(id: string, state: string, timeoutMs = 300_000): Promise<number> {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    try {
      await fly('GET', `/${id}/wait?state=${state}&timeout=60`)
      return now()
    } catch (error) {
      // 408 is the long poll running out; 429 the rate limit.
      if (!/: (408|429) /.test(messageOf(error))) throw error
      await Bun.sleep(500)
    }
  }
  throw new Error(`${id} not ${state} in ${timeoutMs / 1000}s`)
}

/** One status ping: resolves with the server's answer, or rejects within `timeoutMs`. */
function ping(host: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let bytes = Buffer.alloc(0)
    // A deadline of its own, not the socket's idle timeout: Flycast's proxy takes the connection
    // and holds it, silent, while the server behind it is down.
    const timer = setTimeout(() => fail('timeout'), timeoutMs)
    const fail = (why: string) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error(why))
    }
    socket.connect(GAME_PORT, host, () => {
      const port = Buffer.alloc(2)
      port.writeUInt16BE(GAME_PORT)
      socket.write(packet(0x00, Buffer.concat([varInt(0), mcString(host), port, varInt(1)])))
      socket.write(packet(0x00, Buffer.alloc(0)))
    })
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      // A whole status answer is a few hundred bytes; once one JSON object closes, it is in.
      const text = bytes.toString('utf8')
      if (text.includes('"version"') && text.trimEnd().endsWith('}')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(text.slice(text.indexOf('{')))
      }
    })
    socket.on('error', (error) => fail(error.message))
  })
}

/** Pings every 50 ms until one is answered; the time it was. */
async function untilPing(host: string, timeoutMs = 300_000): Promise<number> {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    try {
      await ping(host, 1000)
      return now()
    } catch {
      await Bun.sleep(50)
    }
  }
  throw new Error(`no status answer from ${host} in ${timeoutMs / 1000}s`)
}

interface Joined {
  spawned: number
  loaded: number | null
  blockSeen: string | null
  blockAsExpected: boolean
}

/** A player joining: connected, logged in, spawned, and the bench's block read where it is. */
function join(host: string, expected: string | null, username = BOT): Promise<Joined> {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host, port: GAME_PORT, username, auth: 'offline', hideErrors: true })
    const timer = setTimeout(() => {
      bot.end()
      reject(new Error('no spawn in 120s'))
    }, 120_000)
    const fail = (why: Error) => {
      clearTimeout(timer)
      reject(why)
    }
    bot.once('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
    bot.once('kicked', (reason) => fail(new Error(`kicked: ${JSON.stringify(reason)}`)))
    bot.once('end', (reason) => fail(new Error(`ended: ${String(reason)}`)))
    bot.once('spawn', async () => {
      const spawned = now()
      clearTimeout(timer)
      let seen: string | null = null
      let loaded: number | null = null
      try {
        await bot.waitForChunksToLoad()
        loaded = now()
        const At = bot.entity.position.constructor
        seen =
          expected === null ? null : (bot.blockAt(new At(BLOCK_AT.x, BLOCK_AT.y, BLOCK_AT.z))?.name ?? null)
      } catch {
        seen = null
      }
      bot.end()
      resolve({ spawned, loaded, blockSeen: seen, blockAsExpected: seen === expected })
    })
  })
}

/** The machine's private address, and the server answering on it. */
async function ready(id: string): Promise<string> {
  const machine = await fly<Machine>('GET', `/${id}`)
  const host = machine.private_ip
  if (machine.state !== 'started') {
    await fly('POST', `/${id}/start`)
    await untilState(id, 'started')
  }
  await untilPing(host, 600_000)
  await rcon(host, `whitelist add ${BOT}`)
  // Since 1.21.9 no spawn chunks stay loaded on their own, and a block can't be set or read in
  // one that isn't.
  await rcon(host, `forceload add ${BLOCK_AT.x} ${BLOCK_AT.z}`)
  // The player spawns beside the block, where it can see it.
  await rcon(host, `setworldspawn ${BLOCK_AT.x} 100 ${BLOCK_AT.z}`)
  return host
}

/**
 * Lets the chunk go again before a start from the volume: a forced chunk makes Minecraft load 25
 * at boot, which a Cubepals server doesn't. The player spawns beside the block, so it loads again.
 */
const release = (host: string) => rcon(host, `forceload remove ${BLOCK_AT.x} ${BLOCK_AT.z}`)

const hasBlock = async (host: string, block: string, password?: string) =>
  (
    await rcon(
      host,
      `execute if block ${BLOCK_AT.x} ${BLOCK_AT.y} ${BLOCK_AT.z} minecraft:${block}`,
      password,
    )
  ).includes('passed')

async function setBlock(host: string, block: string, password?: string): Promise<void> {
  const at = `${BLOCK_AT.x} ${BLOCK_AT.y} ${BLOCK_AT.z}`
  const reply = await rcon(host, `setblock ${at} minecraft:${block}`, password)
  if (!(await hasBlock(host, block, password))) throw new Error(`setblock ${block}: ${reply}`)
}

async function suspend(id: string) {
  const asked = now()
  await fly('POST', `/${id}/suspend`)
  const accepted = now()
  const suspended = await untilState(id, 'suspended')
  return { apiMs: Math.round(accepted - asked), suspendMs: Math.round(suspended - asked) }
}

/** A start, timed to the API's answer, the machine `started`, a status ping, and a player in. */
async function start(id: string, host: string, expected: string) {
  const asked = now()
  await fly('POST', `/${id}/start`)
  const accepted = now()
  const [pinged, started] = await Promise.all([untilPing(host), untilState(id, 'started')])
  const { spawned, loaded, ...joined } = await join(host, expected)
  return {
    apiMs: Math.round(accepted - asked),
    startedMs: Math.round(started - asked),
    pingMs: Math.round(pinged - asked),
    // The player in the world, then every chunk around them sent.
    spawnMs: Math.round(spawned - asked),
    chunksMs: loaded === null ? null : Math.round(loaded - asked),
    ...joined,
    blockOverRcon: await hasBlock(host, expected),
  }
}

/** How long `save-all flush` takes over RCON, with the server's reply. */
async function flush(host: string, password?: string) {
  const asked = now()
  const reply = await rcon(host, 'save-all flush', password)
  return { flushMs: Math.round(now() - asked), reply }
}

/**
 * Cubepals' own sleep and wake for a new Free server of `template` at `tier`, in an app of its own
 * (`bly-sbench-…`), through the control plane's FlyRuntime: put to sleep as the stop operation does
 * (`save-all flush`, `sync`, `sleep`), then woken as the start operation does (`ensureProvisioned`,
 * which resumes it, and the status ping), with a player joining as it wakes. `cycles` such wakes,
 * then one after a config change, which drops what it kept: the block set after the save is gone,
 * as it should be. The app goes at the end.
 */
async function flow(template: BenchTemplate, tier: MemoryTier, cycles: number) {
  const runtime = new FlyRuntime({
    client: flyClient(TOKEN, { pace: { perSecond: 5, burst: 10 } }),
    org: 'blockly-staging',
    deploymentId: 'sbench',
    regionMap: { eu: 'fra' },
    snapshotRetentionDays: 1,
    machineLimit: 50,
    platformMachines: 7,
    suspend: async () => true,
  })
  const key = runtimeKey(randomUUID())
  const password = randomBytes(16).toString('hex')
  const made = (await configFor(template, tier, '')).spec
  const spec = { ...made, secrets: { ...made.secrets, RCON_PASSWORD: password } }
  const steps: string[] = []
  const progress = { step: async (step: string) => void steps.push(step), handle: async () => {} }
  const placement = { regionKey: 'eu' }
  try {
    const asked = now()
    let handle = await runtime.ensureProvisioned(key, placement, spec, progress)
    const host = runtime.endpoint(handle, PORT_NAMES.game, 'control').host
    emit({
      job: 'flow',
      template,
      tier,
      key,
      firstBootMs: Math.round((await untilPing(host, 900_000)) - asked),
    })
    for (const command of [`whitelist add ${BOT}`, `forceload add 0 0`, `setworldspawn 0 100 0`])
      await rcon(host, command, password)
    for (let cycle = 1; cycle <= cycles + 1; cycle++) {
      const dropped = cycle > cycles
      const block = BLOCKS[(cycle - 1) % BLOCKS.length] ?? 'gold_block'
      const saved = await flush(host, password)
      await setBlock(host, block, password)
      const synced = (await runtime.exec(handle, ['sync'], 60)).exitCode === 0
      const sleeping = now()
      const slept = await runtime.sleep?.(handle)
      const sleepMs = Math.round(now() - sleeping)
      await Bun.sleep(10_000)
      const wake = dropped ? { ...spec, env: { ...spec.env, BENCH_CHANGED: String(cycle) } } : spec
      steps.length = 0
      const woken = now()
      handle = await runtime.ensureProvisioned(key, placement, wake, progress)
      const startedMs = Math.round(now() - woken)
      const pingMs = Math.round((await untilPing(host, 900_000)) - woken)
      const joined = await join(host, block).then(
        ({ spawned, loaded, blockAsExpected }) => ({
          spawnMs: Math.round(spawned - woken),
          chunksMs: loaded === null ? null : Math.round(loaded - woken),
          blockAsExpected,
        }),
        (error: unknown) => ({ joinError: messageOf(error) }),
      )
      emit({
        job: 'flow',
        template,
        tier,
        cycle,
        dropped,
        ...saved,
        synced,
        slept,
        sleepMs,
        steps: [...steps],
      })
      emit({ job: 'flow', template, tier, cycle, startedMs, pingMs, ...joined })
    }
  } finally {
    await runtime.destroy(key)
  }
}

/**
 * A person joining a server asleep through the edge, as the game's client does: the join wakes it,
 * and the edge holds it until the server answers (`answeredMs`, any loader). Then a player joins
 * the world (`spawnMs`), joining again `perSecond` while turned away; a modded server a plain
 * client can't join says why instead. Times from the first join.
 */
async function edgeJoin(hostname: string, perSecond: number) {
  const asked = now()
  const answeredMs = await answered({ host: hostname, port: GAME_PORT }, hostname, 'BenchProbe', 600_000)
  let tries = 0
  let refused: string | null = null
  while (now() - asked < 300_000) {
    tries++
    try {
      const { spawned, loaded } = await join(hostname, null, `Bench${randomBytes(3).toString('hex')}`)
      const chunksMs = loaded === null ? null : Math.round(loaded - asked)
      return { answeredMs, tries, refused, spawnMs: Math.round(spawned - asked), chunksMs }
    } catch (error) {
      refused ??= messageOf(error)
      await Bun.sleep(1000 / perSecond)
    }
  }
  return { answeredMs, tries, refused, spawnMs: null, chunksMs: null }
}

/** The snapshot dropped while suspended, by a stop or by a config update, then a start timed. */
async function dropped(job: string, id: string, host: string) {
  await flush(host)
  // Placed after the last save: a cold start that kept it would show the stop saved the world.
  await setBlock(host, 'emerald_block')
  await release(host)
  const down = await suspend(id)
  const asked = now()
  if (job === 'drop-stop') await fly('POST', `/${id}/stop`)
  else {
    const machine = await fly<Machine>('GET', `/${id}`)
    const config = { ...machine.config, metadata: { ...machine.config.metadata, bench: String(Date.now()) } }
    await fly('POST', `/${id}`, { config, skip_launch: true })
  }
  const how = {
    how: job === 'drop-stop' ? 'stop' : 'update',
    state: (await fly<Machine>('GET', `/${id}`)).state,
    ms: Math.round(now() - asked),
  }
  await Bun.sleep(5000)
  const before = (await fly<Machine>('GET', `/${id}`)).state
  const resume = await start(id, host, 'emerald_block').catch((error: unknown) => ({
    error: messageOf(error),
  }))
  emit({ job, id, suspend: down, dropped: how, stateBeforeStart: before, resume })
}

/** The bench's own jobs, on one of its machines: its private address, and what the job runs. */
const JOBS: Record<string, (id: string, host: string, count: number) => Promise<void>> = {
  cycles: async (id, host, count) => {
    for (let cycle = 1; cycle <= count; cycle++) {
      const block = BLOCKS[(cycle - 1) % BLOCKS.length] ?? 'gold_block'
      const saved = await flush(host)
      // Placed after the flush: only the snapshot holds it.
      await setBlock(host, block)
      const down = await suspend(id)
      await Bun.sleep(10_000)
      emit({ job: 'cycles', id, cycle, ...saved, suspend: down, resume: await start(id, host, block) })
      await Bun.sleep(20_000)
    }
  },
  suspend: async (id, host) => {
    await setBlock(host, 'gold_block')
    emit({ job: 'suspend', id, suspend: await suspend(id) })
  },
  resume: async (id, host) => emit({ job: 'resume', id, resume: await start(id, host, 'gold_block') }),
  cold: async (id, host) => {
    await flush(host)
    await setBlock(host, 'diamond_block')
    await release(host)
    const asked = now()
    await fly('POST', `/${id}/stop`)
    const stopped = await untilState(id, 'stopped')
    emit({
      job: 'cold',
      id,
      stopMs: Math.round(stopped - asked),
      start: await start(id, host, 'diamond_block'),
    })
  },
  'drop-stop': (id, host) => dropped('drop-stop', id, host),
  'drop-update': (id, host) => dropped('drop-update', id, host),
  flush: async (id, host, count) => {
    for (let i = 0; i < count; i++) emit({ job: 'flush', id, ...(await flush(host)) })
  },
}

async function main(): Promise<void> {
  const [job = '', id = '', count = '5', cycles = '3'] = process.argv.slice(2)
  if (job === 'flow') return flow(id as BenchTemplate, count as MemoryTier, Number(cycles))
  if (job === 'edge-join') {
    emit({ job, hostname: id, ...(await edgeJoin(id, Number(count))) })
    return
  }
  const run = JOBS[job]
  if (run === undefined) throw new Error(`no job ${job}`)
  // A resume is timed from the suspended machine: getting it ready first would resume it untimed.
  const host = job === 'resume' ? (await fly<Machine>('GET', `/${id}`)).private_ip : await ready(id)
  await run(id, host, Number(count))
}

await main().then(
  () => process.exit(0),
  (error: unknown) => {
    const [job, id] = process.argv.slice(2)
    emit({ job, id, error: messageOf(error) })
    process.exit(1)
  },
)
