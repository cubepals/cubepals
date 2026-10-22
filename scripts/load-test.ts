// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A load test of the whole product on staging that behaves like real people, who don't know about
 * each other and don't wait for each other. They arrive at random, a Poisson stream, each with
 * their own account and server, and live their own lives through the same public paths the
 * website uses (`lib/load-player.ts`), their friends played by headless players (mineflayer)
 * joining at each server's own address from probe machines in a temporary app of their own
 * (`lib/load-probe.ts`), since the game port can't be reached from here. About a third of them are
 * careless or impatient somewhere (`lib/load-chaos.ts`), and mid-run the platform is shaken once
 * each way: the control plane's worker restarted, a running server's machine stopped from Fly
 * behind the product's back, the edge restarted.
 *
 *   bun scripts/load-test.ts [--arrivals 60] [--over 20] [--plan free|plus|mix] [--friends 3-10]
 *                            [--play 3-15] [--idle 1] [--aggression 0.33] [--probes n]
 *                            [--out local/load-test/<run>]
 *   bun scripts/load-test.ts clean     what an earlier run left: its servers purged, its probes gone
 *
 * About `--arrivals` people come over `--over` minutes; each server gets a random number of
 * friends in `--friends`, each playing a random number of minutes in `--play`. `--idle` is the
 * minutes an empty server waits before the product puts it to sleep (an account's own idle time,
 * as the staging check sets it, rather than the plan's). With `--plan mix` each person is on Plus
 * or Free at even odds; Free keeps account checks on, so a headless player only reaches its
 * server. Every 15 seconds it prints a line: people arrived and active, where they are, players in
 * a world, the platform's health as the admin health page reads it, and the database's
 * connections. At the end every server the run made is in the trash and purged, the probes are
 * destroyed, the accounts are kept (they are test-domain accounts), and the report goes to
 * `<out>.json` and `<out>.md` (`lib/load-report.ts`).
 *
 * Run `bun scripts/staging.ts start` first. The database is reached through the first probe,
 * which forwards it, since the session reaches only HTTP and Fly's own proxy.
 */
import { createHash, randomUUID } from 'node:crypto'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { MAIL_PORT } from '@blockly/contracts/local'
import { SQL } from 'bun'
import { runScheduledNow } from '../apps/control/src/infra/pg/jobs.ts'
import type { ChaosFinding } from './lib/load-chaos.ts'
import { Player, type StepRecord } from './lib/load-player.ts'
import {
  DATABASE_PORT,
  fly,
  PLAYERS_PER_PROBE,
  Probe,
  probesDown,
  probesUp,
  tunnel,
} from './lib/load-probe-fleet.ts'
import {
  failuresOf,
  firstLimit,
  hoursBySize,
  type MachineRun,
  type Moment,
  markdown,
  type PartStats,
  partStats,
  type Report,
  runningMs,
  stepStats,
  took,
  write,
} from './lib/load-report.ts'
import { type Api, people } from './lib/people.ts'
import { privateDatabaseUrl } from './lib/staging-database.ts'

const WEB = 'https://staging.cubepals.com'
const MAILPIT = 'http://127.0.0.1:18025'
const ADMIN_EMAIL = 'admin@staging.blockly.test'
const PROBE_PREFIX = 'bly-load-probe-'
/** The most events Fly's Machines API lists at once, as its own refusal of more says. */
const EVENTS_LIMIT = 50

const say = (line: string) => process.stdout.write(`${line}\n`)
const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const state = JSON.parse(process.env.STAGING_STATE ?? '{}') as { authSecret?: string }
const databaseUrl = state.authSecret ? privateDatabaseUrl({ ...state, authSecret: state.authSecret }) : ''
if (!state.authSecret || databaseUrl === '') {
  say('No staging to test: STAGING_STATE is needed, and STAGING_DATABASE_URL with STAGING_DATABASE=supabase.')
  process.exit(2)
}
// The staging check's accounts' domain, on staging's sign-up allowlist (staging.ts derives it).
const DOMAIN = `${createHash('sha256').update(state.authSecret).digest('hex').slice(0, 12)}.check.staging.blockly.test`
// Every server a run makes starts its create key with this, so `clean` finds what a run left.
const MARK = createHash('sha256').update(`load-test:${state.authSecret}`).digest('hex')
const KEY_PREFIX = `${MARK.slice(0, 8)}-${MARK.slice(8, 12)}-`

/** Staging's database through the first probe's forward: the same database, over Fly's proxy. */
const tunnelled = new URL(databaseUrl)
const databaseHost = tunnelled.hostname
tunnelled.hostname = '127.0.0.1'
tunnelled.port = String(DATABASE_PORT)
const database = new SQL(tunnelled.toString())
/** One statement; what it answers is the first column of its first row. */
async function sql(statement: string): Promise<string> {
  const [row] = (await database.unsafe(statement).values()) as unknown[][]
  return row?.[0] == null ? '' : String(row[0])
}

/** Answers the product sent back as "slow down" or a server error, counted by path: its own retries included. */
const refused = new Map<string, number>()
const plainFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await plainFetch(input, init)
    if (response.status === 429 || response.status >= 500) {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        .pathname
      const key = `${response.status} ${path}`
      refused.set(key, (refused.get(key) ?? 0) + 1)
    }
    return response
  },
  plainFetch,
)

/** The staging admin, signed in through the mail catcher as anyone with its inbox would. */
async function admin(): Promise<Api> {
  const site = people(WEB, MAILPIT)
  const password = `load-${randomUUID()}`
  if ((await sql(`select id from users where email = '${ADMIN_EMAIL}'`)) === '')
    return (await site.person(ADMIN_EMAIL, password)).api
  const reset = await site.auth('request-password-reset', {
    email: ADMIN_EMAIL,
    redirectTo: '/reset-password',
  })
  if (!reset.ok) throw new Error(`a password reset for the admin answered ${reset.status}`)
  // The catcher lists the newest first; an earlier reset's mail is older than this one's.
  await Bun.sleep(3 * SECOND_MS)
  const token =
    /reset-password\/([^?/\s]+)/.exec(await site.mailedLink(ADMIN_EMAIL, /reset-password/))?.[1] ?? ''
  const done = await site.auth('reset-password', { newPassword: password, token })
  if (!done.ok) throw new Error(`resetting the admin's password answered ${done.status}`)
  const cookie = site.cookiesOf(await site.auth('sign-in/email', { email: ADMIN_EMAIL, password }))
  return site.apiAs(() => cookie)
}

/** Fly's own record of each of an app's machines: its size and how long it ran. */
async function machineRuns(app: string): Promise<MachineRun[]> {
  const machines = JSON.parse((await fly(['machines', 'list', '-a', app, '--json'])) || '[]') as {
    id: string
    config: { guest: { cpu_kind: string; cpus: number; memory_mb: number } }
  }[]
  return Promise.all(
    machines.map(async (m) => {
      const response = await fetch(
        `https://api.machines.dev/v1/apps/${app}/machines/${m.id}/events?limit=${EVENTS_LIMIT}`,
        { headers: { authorization: `Bearer ${process.env.FLY_API_TOKEN}` } },
      )
      if (!response.ok) throw new Error(`Fly's events for ${m.id} answered ${response.status}`)
      const events = (await response.json()) as { status: string; timestamp: number }[]
      const { cpu_kind, cpus, memory_mb } = m.config.guest
      return {
        app,
        machine: m.id,
        size: `${cpu_kind}-${cpus}x ${memory_mb} MB`,
        runningMs: runningMs(events),
      }
    }),
  )
}

const appOf = (serverId: string) => `bly-staging-${serverId.replaceAll('-', '')}`
const serverApps = async () =>
  (JSON.parse(await fly(['apps', 'list', '-o', 'blockly-staging', '--json'])) as { Name: string }[]).map(
    (a) => a.Name,
  )

/** These servers purged by the product's own sweep, run now; the ones still not purged after `limitS`. */
async function purge(ids: readonly string[], limitS: number): Promise<string[]> {
  if (ids.length === 0) return []
  const list = ids.map((id) => `'${id}'`).join(', ')
  await sql(
    `update minecraft_servers set status = 'deleted', deleted_at = coalesce(deleted_at, now()), purge_after = now() - interval '1 minute' where id in (${list}) and status <> 'purged'`,
  )
  await runScheduledNow(tunnelled.toString(), 'purge-sweep')
  const deadline = Date.now() + limitS * SECOND_MS
  for (;;) {
    const left = (await database.unsafe(
      `select id from minecraft_servers where id in (${list}) and status <> 'purged'`,
    )) as { id: string }[]
    if (left.length === 0 || Date.now() > deadline) return left.map((s) => s.id)
    await Bun.sleep(5 * SECOND_MS)
  }
}

if (process.argv[2] === 'clean') {
  // A probe a run left may be stopped, its forward with it: a helper of its own reaches the database.
  const probes = (await serverApps()).filter((app) => app.startsWith(PROBE_PREFIX))
  const helper = `${PROBE_PREFIX}clean-${Date.now()}`
  await probesUp(helper, 1, databaseHost)
  const left = (await database.unsafe(
    `select id from minecraft_servers where create_idempotency_key like '${KEY_PREFIX}%' and status <> 'purged'`,
  )) as { id: string }[]
  const stuck = await purge(
    left.map((s) => s.id),
    900,
  )
  say(
    `${left.length - stuck.length} servers purged${stuck.length ? `, still not purged: ${stuck.join(', ')}` : ''}`,
  )
  for (const app of new Set([...probes, helper])) await probesDown(app).catch(() => undefined)
  say('probes destroyed')
  process.exit(stuck.length === 0 ? 0 : 1)
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

// A burst (`--people`) has everyone arrive within `--ramp` seconds, play, and stop there: no
// sleep, nothing after it, nobody careless, the platform left alone.
const burst = process.argv.includes('--people')
const burstPeople = Number(option('people', '50'))
const rampS = Number(option('ramp', '60'))
const arrivals = burst ? burstPeople : Number(option('arrivals', '60'))
const overMinutes = Number(option('over', '20'))
const planChoice = option('plan', 'mix')
const rangeOf = (name: string, fallback: string): [number, number] => {
  const [, least = '0', most = least] = /^(\d+)(?:-(\d+))?$/.exec(option(name, fallback)) ?? []
  return [Number(least), Number(most)]
}
const friends = rangeOf('friends', '3-10')
const playMinutes = rangeOf('play', '3-15')
const idleMinutes = Number(option('idle', '1'))
const aggression = burst ? 0 : Number(option('aggression', '0.33'))
const run = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')
const out = option('out', `local/load-test/${run}`)
const planOf = (): 'free' | 'plus' =>
  planChoice === 'free' || planChoice === 'plus' ? planChoice : Math.random() < 0.5 ? 'plus' : 'free'
/**
 * When each person arrives, ms from the start: a Poisson stream, each gap drawn from the
 * exponential with the mean `--over` / `--arrivals`, so about `--arrivals` come in `--over`.
 */
const arrivalTimes: number[] = burst
  ? Array.from({ length: burstPeople }, (_, i) => (i * rampS * SECOND_MS) / burstPeople)
  : []
for (let at = 0; !burst; ) {
  at += -Math.log(1 - Math.random()) * ((overMinutes * MINUTE_MS) / arrivals)
  if (at > overMinutes * MINUTE_MS) break
  arrivalTimes.push(at)
}
// In a burst each person's plan and players are picked as they are counted, and there are probes
// for all of their players at once: `--players a-b` on each Plus server, the owner among them.
const playersEach = rangeOf('players', '3-6')
const pickedPlan = arrivalTimes.map(() => planOf())
const pickedPlayers = arrivalTimes.map(
  () => playersEach[0] + Math.floor(Math.random() * (playersEach[1] - playersEach[0] + 1)),
)
const burstBots = pickedPlan.reduce(
  (sum, plan, i) => sum + (plan === 'plus' ? (pickedPlayers[i] ?? 0) : 0),
  0,
)
// Otherwise enough for the players likely in a world at once: half the people on Plus, each with
// their friends, most of their play overlapping.
const probeCount = Number(
  option(
    'probes',
    String(
      Math.ceil(
        burst
          ? burstBots / PLAYERS_PER_PROBE
          : (arrivals * 0.5 * (1 + (friends[0] + friends[1]) / 2) * 0.8) / PLAYERS_PER_PROBE,
      ),
    ),
  ),
)
const probeApp = `${PROBE_PREFIX}${run}`

if (burst)
  say(
    `burst ${run}: ${burstPeople} people within ${rampS}s (${planChoice}), ${playersEach.join('-')} players a Plus server (${burstBots} headless), ${playMinutes.join('-')} min of play, at ${WEB}`,
  )
else
  say(
    `load test ${run}: ${arrivalTimes.length} people arriving over ${overMinutes} min (${planChoice}), ${friends.join('-')} friends, ${playMinutes.join('-')} min of play, a share of ${aggression} careless, at ${WEB}`,
  )
tunnel(18025, MAIL_PORT, 'bly-staging-mail')
say(`${probeCount} probes, in ${probeApp}`)
const probes: Probe[] = await probesUp(probeApp, probeCount, databaseHost)
const operator = await admin()
const site = people(WEB, MAILPIT)
// The run's clock starts as people start arriving, the probes already up.
const started = Date.now()

const records: StepRecord[] = []
const chaos: ChaosFinding[] = []
const machines: MachineRun[] = []
/** What Fly says a server's machine is: `none` without one, `not on Fly` for a server on another runtime. */
const machineState = async (serverId: string) => {
  const listed = await fly(['machines', 'list', '-a', appOf(serverId), '--json']).catch((error: unknown) => {
    if (/app not found/i.test((error as Error).message)) return null
    throw error
  })
  if (listed === null) return 'not on Fly'
  return (JSON.parse(listed || '[]') as { state: string }[])[0]?.state ?? 'none'
}
const playerRun = {
  id: run,
  domain: DOMAIN,
  key: () => `${KEY_PREFIX}${randomUUID().slice(14)}`,
  signUp: (email: string) => site.person(email),
  auth: (path: string, body: unknown) => site.auth(path, body, '', 1),
  mailpit: MAILPIT,
  sql,
  probes,
  friends,
  playMinutes,
  idleMinutes,
  aggression,
  machineState,
  record: (step: StepRecord) => {
    records.push(step)
    if (!step.ok)
      say(`  FAIL ${step.player} ${step.step}: ${step.error}${step.operation ? ` | ${step.operation}` : ''}`)
  },
  chaos: (finding: ChaosFinding) => {
    chaos.push(finding)
    say(`  CHAOS ${finding.player ?? 'platform'} ${finding.act}: ${finding.verdict}: ${finding.did}`)
  },
  beforeTrash: async (serverId: string) => {
    machines.push(
      ...(await machineRuns(appOf(serverId)).catch((error: unknown) => {
        say(`  machine hours of ${serverId} unread: ${(error as Error).message}`)
        return []
      })),
    )
  },
}
const players: Player[] = []

// ─── Watching it run ─────────────────────────────────────────────────────────────────────────

const timeline: Moment[] = []
const peak: Record<string, number> = {}
const atPeak = (what: string, n: number) => {
  peak[what] = Math.max(peak[what] ?? 0, n)
}
async function line(): Promise<string> {
  const of = (phase: string) => players.filter((p) => p.phase === phase).length
  const active = players.length - of('done')
  const mine = `people ${players.length}/${arrivalTimes.length} arrived, ${active} active · making ${of('making')}, playing ${of('playing')}, asleep ${of('asleep')}, away ${of('away')}, done ${of('done')}, with a failure ${players.filter((p) => p.failed).length}`
  // biome-ignore lint/suspicious/noExplicitAny: HealthView, read for a line
  const view: any = await operator('admin.health', {}, 'GET').catch(() => null)
  const counts = view?.now.servers ?? { running: 0, asleep: 0, busy: 0, failed: 0 }
  const sum = (key: 'queued' | 'running') =>
    (view?.now.operations ?? []).reduce(
      (total: number, o: Record<string, number>) => total + (o[key] ?? 0),
      0,
    )
  const inWorld = (
    await Promise.all(
      probes.map((p) =>
        p.load().then(
          (l) => l.players,
          () => 0,
        ),
      ),
    )
  ).reduce((a, b) => a + b, 0)
  const connections = Number(await sql('select count(*) from pg_stat_activity').catch(() => '0'))
  timeline.push({
    t: Date.now() - started,
    active,
    making: of('making'),
    playing: of('playing'),
    running: counts.running,
    asleep: counts.asleep,
    busy: counts.busy,
    inWorld,
    queued: sum('queued'),
  })
  for (const [what, n] of Object.entries({
    'people active': active,
    'running servers': counts.running,
    'busy servers': counts.busy,
    'players in a world': inWorld,
    'operations queued': sum('queued'),
    'operations running': sum('running'),
    'database connections': connections,
  }))
    atPeak(what, n)
  const health =
    view === null
      ? 'health unread'
      : `health: running ${counts.running}, asleep ${counts.asleep}, busy ${counts.busy}, failed ${counts.failed}; operations queued ${sum('queued')}, running ${sum('running')}`
  return `${took(Date.now() - started).padStart(7)}  ${mine} | in a world ${inWorld} | ${health} | db connections ${connections}`
}
// One line at a time: a slow answer skips a beat rather than printing two at once.
let reading = false
const watching = setInterval(() => {
  if (reading) return
  reading = true
  void line()
    .then(say)
    .finally(() => {
      reading = false
    })
}, 15 * SECOND_MS)

// ─── The platform shaken, once each, mid-run, on staging only ────────────────────────────────

/** A step failure between `from` and `to`, ms since the epoch. */
const failedBetween = (from: number, to: number) =>
  records.filter((r) => !r.ok && r.at + r.ms >= from && r.at + r.ms <= to)

/** The control plane's worker restarted: what was under way, and what became of it. */
async function restartControl(): Promise<void> {
  const app = 'bly-staging-control'
  const all = JSON.parse(await fly(['machines', 'list', '-a', app, '--json'])) as {
    id: string
    config: { metadata?: Record<string, string> }
  }[]
  const machine = all.find((m) => m.config.metadata?.fly_process_group === 'worker') ?? all[0]
  const at = Date.now()
  const underWay = await sql(`select count(*) from server_operations where status in ('queued', 'running')`)
  await fly(['machine', 'restart', machine?.id ?? '', '-a', app])
  await Bun.sleep(10 * MINUTE_MS)
  const after = (await database.unsafe(
    `select status, count(*)::int as n from server_operations
     where created_at < to_timestamp(${at / SECOND_MS}) and (finished_at is null or finished_at > to_timestamp(${at / SECOND_MS}))
     group by status`,
  )) as { status: string; n: number }[]
  const of = (status: string) => after.find((a) => a.status === status)?.n ?? 0
  const failed = failedBetween(at, at + 3 * MINUTE_MS).length
  const did = `${underWay} operations under way; ten minutes on, of those: ${of('succeeded')} succeeded, ${of('failed')} failed, ${of('running') + of('queued')} still open; ${failed} people's steps failed in the 3 minutes after`
  const verdict =
    of('running') + of('queued') > 0 ? 'stuck' : of('failed') > 0 || failed > 0 ? 'interrupted' : 'fine'
  playerRun.chaos({
    act: `the control plane's ${machine?.config.metadata?.fly_process_group ?? ''} machine restarted`,
    player: null,
    at,
    did,
    verdict,
  })
}

/** A running server's machine stopped from Fly behind the product's back: does it notice, and say so? */
async function stopBehindItsBack(): Promise<void> {
  const owner = players.find((p) => p.phase === 'playing' && p.servers[0] !== undefined)
  const server = owner?.servers[0]
  if (owner === undefined || server === undefined) return
  const app = appOf(server.id)
  const [machine] = JSON.parse(await fly(['machines', 'list', '-a', app, '--json'])) as { id: string }[]
  const at = Date.now()
  await fly(['machine', 'stop', machine?.id ?? '', '-a', app])
  const seen: string[] = []
  let last = ''
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(10 * SECOND_MS)
    const view = await owner.look(server.id).catch(() => null)
    const now = `${view?.status ?? 'unread'}${view?.stopReason ? ` (${view.stopReason})` : ''}/${await machineState(server.id)}`
    if (now !== last) seen.push(`${took(Date.now() - at)}: website ${now.replace('/', ', Fly ')}`)
    last = now
  }
  const [website = '', onFly = ''] = last.split('/')
  const lying = website.startsWith('running') && onFly !== 'started'
  playerRun.chaos({
    act: "a running server's machine stopped from Fly behind the product's back",
    player: owner.index,
    server: server.id,
    at,
    did: seen.join('; '),
    // Saying it runs while Fly has it stopped is a wrong state; noticing, either way, only
    // interrupts the people on it.
    verdict: lying ? 'wrong state' : 'interrupted',
  })
}

/** The edge restarted: who was dropped, and whether people get back in. */
async function restartEdge(): Promise<void> {
  const app = 'bly-staging-edge'
  const all = JSON.parse(await fly(['machines', 'list', '-a', app, '--json'])) as { id: string }[]
  const at = Date.now()
  for (const machine of all) await fly(['machine', 'restart', machine.id, '-a', app])
  await Bun.sleep(5 * MINUTE_MS)
  const failed = failedBetween(at, at + 5 * MINUTE_MS)
  const dropped = failed.filter((r) => /dropped mid-play/.test(r.error ?? '')).length
  const joinsFailed = failed.length - dropped
  const verdict = joinsFailed > 0 ? 'stuck' : dropped > 0 ? 'interrupted' : 'fine'
  playerRun.chaos({
    act: 'the edge restarted',
    player: null,
    at,
    did: `${dropped} players dropped mid-play; ${joinsFailed} other steps failed in the 5 minutes after: ${[...new Set(failed.map((r) => r.error?.slice(0, 80)))].slice(0, 3).join(' | ')}`,
    verdict,
  })
}

const shaken = Promise.all(
  (burst
    ? []
    : ([
        [0.45, restartControl],
        [0.6, stopBehindItsBack],
        [0.75, restartEdge],
      ] as const)
  ).map(async ([share, shake]) => {
    await Bun.sleep(share * overMinutes * MINUTE_MS)
    await shake().catch((error: unknown) =>
      say(`  the platform shake ${shake.name} failed: ${(error as Error).message}`),
    )
  }),
)

// ─── People arrive at random, each living their own life ─────────────────────────────────────

// The last arrival, the longest play, and room for every wait a life can have: past it, the
// report is written with whoever is still going counted as such.
const lastArrival = arrivalTimes.at(-1) ?? 0
const deadline = lastArrival + (playMinutes[1] + 45) * MINUTE_MS
const lives = Promise.all(
  arrivalTimes.map(async (at, i) => {
    await Bun.sleep(at)
    const player = burst
      ? new Player(i, pickedPlan[i] ?? 'free', playerRun, { friends: (pickedPlayers[i] ?? 1) - 1, burst })
      : new Player(i, planOf(), playerRun)
    players.push(player)
    await player.live().catch((error: unknown) => {
      say(`  person ${i} stopped: ${(error as Error).message}`)
      player.failed = true
    })
  }),
)
await Promise.race([
  lives,
  Bun.sleep(deadline).then(() =>
    say(`  past the deadline: ${players.filter((p) => p.phase !== 'done').length} people still going`),
  ),
])
await shaken
clearInterval(watching)
say(await line())

/** The report as it stands: written as soon as people are done, and again after the cleanup. */
const reportNow = (extra: {
  createParts?: PartStats[]
  operationRetries?: Report['operationRetries']
}): Report => {
  const limit = firstLimit(records)
  return {
    run,
    arrivals: arrivalTimes.length,
    overMinutes,
    plan: planChoice,
    startedAt: new Date(started).toISOString(),
    tookMs: Date.now() - started,
    steps: stepStats(records),
    failures: failuresOf(records),
    chaos,
    firstLimit: limit && { limit: limit.limit, step: limit.record.step, error: limit.record.error ?? '' },
    timeline,
    createParts: extra.createParts ?? [],
    machineHours: hoursBySize(machines),
    peak: {
      ...peak,
      'probe requests sent again (the test’s tunnel, not the product)': Probe.resent,
      ...Object.fromEntries([...refused].map(([path, n]) => [`answers ${path}`, n])),
    },
    operationRetries: extra.operationRetries ?? [],
    records,
  }
}
// Where the run's servers were made, by runtime, read before the cleanup lets them go.
const madeIds = players.flatMap((p) => p.servers.map((sv) => `'${sv.id}'`)).join(', ') || 'null'
const byRuntime = (await database
  .unsafe(
    `select provider, count(*)::int as n from server_runtimes where server_id in (${madeIds}) group by provider`,
  )
  .catch(() => [])) as { provider: string; n: number }[]
for (const { provider, n } of byRuntime) peak[`servers made on ${provider}`] = n
// Whatever the cleanup meets, what the people met is kept first.
write(out, reportNow({}))
say(`people done: the report so far is in ${out}.md`)

// ─── Everything the run made, gone ───────────────────────────────────────────────────────────

await Promise.all(players.map((player) => player.tidy()))
const made = players.flatMap((p) => p.servers.map((s) => s.id))
const thrown = (await database.unsafe(
  `select id from minecraft_servers where create_idempotency_key like '${KEY_PREFIX}%' and status <> 'purged' and created_at > to_timestamp(${started / SECOND_MS})`,
)) as { id: string }[]
// What careless acts made and trashed themselves is the run's too.
const ids = [...new Set([...made, ...thrown.map((s) => s.id)])]
say(`\npurging ${ids.length} servers`)
const stuck = await purge(ids, 900)
const apps = new Set(await serverApps())
const appsLeft = ids.map(appOf).filter((app) => apps.has(app))
say(`${ids.length - stuck.length} purged; not purged: ${stuck.length}; Fly apps left: ${appsLeft.length}`)
const idList = ids.map((id) => `'${id}'`).join(', ') || 'null'
const retries = (await database.unsafe(
  `select kind, count(*)::int as operations,
     count(*) filter (where (select count(*) from jsonb_array_elements(coalesce(steps, '[]'::jsonb)) s where s->>'step' = 'attempt') > 1)::int as retried,
     count(*) filter (where status = 'failed')::int as failed
   from server_operations where server_id in (${idList}) group by kind order by kind`,
)) as Array<{ kind: string; operations: number; retried: number; failed: number }>
// The first create of each person, by the steps its operation records: the wait in the queue,
// each step, and the wait from its end until the website showed it running.
const provisions = (await database.unsafe(
  `select server_id, created_at, finished_at, steps from server_operations
   where kind = 'provision' and status = 'succeeded' and server_id in (${players.map((p) => (p.servers[0] ? `'${p.servers[0].id}'` : 'null')).join(', ') || 'null'})`,
)) as {
  server_id: string
  created_at: Date
  finished_at: Date
  steps: { step: string; at: string }[] | null
}[]
const parts = provisions.flatMap((op) => {
  const steps = (op.steps ?? []).map((s) => ({ step: s.step, at: Date.parse(s.at) }))
  const created = new Date(op.created_at).getTime()
  const finished = new Date(op.finished_at).getTime()
  const shown = records.find(
    (r) => r.ok && r.server === op.server_id && r.step === 'make a server, until it is running',
  )
  return [
    { part: 'queued', ms: (steps[0]?.at ?? finished) - created },
    ...steps.map((s, k) => ({ part: s.step, ms: (steps[k + 1]?.at ?? finished) - s.at })),
    ...(shown ? [{ part: 'until the website showed it running', ms: shown.at + shown.ms - finished }] : []),
  ]
})
machines.push(
  ...(await machineRuns(probeApp).catch((error: unknown) => {
    say(`machine hours of the probes unread: ${(error as Error).message}`)
    return []
  })),
)
await probesDown(probeApp)

const report = reportNow({ createParts: partStats(parts), operationRetries: retries })
write(out, report)
say(`\n${markdown(report)}`)
say(`written to ${out}.json and ${out}.md`)
if (stuck.length > 0 || appsLeft.length > 0)
  say(`left behind: ${[...stuck, ...appsLeft].join(', ')}: run \`bun scripts/load-test.ts clean\``)
process.exit(stuck.length === 0 && appsLeft.length === 0 ? 0 : 1)
