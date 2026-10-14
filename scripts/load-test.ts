// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A load test of the whole product on staging: N people at once, each with their own account and
 * server, doing what a real one does through the same public paths the website uses
 * (`lib/load-player.ts`), with headless players (mineflayer) joining at each server's own address
 * from probe machines in a temporary app of their own (`lib/load-probe.ts`), since the game port
 * can't be reached from here.
 *
 *   bun scripts/load-test.ts [--people 50] [--ramp 120] [--plan free|plus|mix] [--play 5]
 *                            [--idle 1] [--out local/load-test/<run>]
 *   bun scripts/load-test.ts clean     what an earlier run left: its servers purged, its probes gone
 *
 * `--ramp` is the seconds over which people arrive, `--play` the minutes they play, `--idle` the
 * minutes an empty server waits before the product puts it to sleep (an account's own idle time,
 * as the staging check sets it, rather than the plan's). With `--plan mix` every other person is
 * on Plus. Every 15 seconds it prints a line: accounts made, servers making, ready, with players,
 * asleep and failed, the platform's health as the admin health page reads it, the database's
 * connections and the probes' load. At the end every server it made is in the trash and purged,
 * the probes are destroyed, the accounts are kept (they are test-domain accounts), and the report
 * goes to `<out>.json` and `<out>.md` (`lib/load-report.ts`).
 *
 * Run `bun scripts/staging.ts start` first. The database is reached through the first probe,
 * which forwards it, since the session reaches only HTTP and Fly's own proxy.
 */
import { createHash, randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import { MAIL_PORT } from '@blockly/contracts/local'
import { SQL } from 'bun'
import { runScheduledNow } from '../apps/control/src/infra/pg/jobs.ts'
import { Player, type StepRecord } from './lib/load-player.ts'
import {
  DATABASE_PORT,
  fly,
  PLAYERS_PER_PROBE,
  type Probe,
  probesDown,
  probesUp,
  tunnel,
} from './lib/load-probe-fleet.ts'
import {
  failuresOf,
  firstLimit,
  hoursBySize,
  type MachineRun,
  markdown,
  runningMs,
  stepStats,
  took,
  write,
} from './lib/load-report.ts'
import { type Api, people } from './lib/people.ts'

const WEB = 'https://staging.cubepals.com'
const MAILPIT = 'http://127.0.0.1:18025'
const ADMIN_EMAIL = 'admin@staging.blockly.test'
const PROBE_PREFIX = 'bly-load-probe-'

const say = (line: string) => process.stdout.write(`${line}\n`)
const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const state = JSON.parse(process.env.STAGING_STATE ?? '{}') as { authSecret?: string }
const databaseUrl = process.env.STAGING_DATABASE_URL ?? ''
if (!state.authSecret || databaseUrl === '') {
  say('No staging to test: STAGING_STATE and STAGING_DATABASE_URL are needed.')
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
      const events = (await (
        await fetch(`https://api.machines.dev/v1/apps/${app}/machines/${m.id}/events?limit=200`, {
          headers: { authorization: `Bearer ${process.env.FLY_API_TOKEN}` },
        })
      ).json()) as { status: string; timestamp: number }[]
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
  tunnel(18025, MAIL_PORT, 'bly-staging-mail')
  const probes = (await serverApps()).filter((app) => app.startsWith(PROBE_PREFIX))
  const helper = probes[0] ?? `${PROBE_PREFIX}clean`
  if (probes.length === 0) await probesUp(helper, 1, databaseHost)
  else
    tunnel(
      DATABASE_PORT,
      5432,
      helper,
      `${(JSON.parse(await fly(['machines', 'list', '-a', helper, '--json'])) as { id: string }[])[0]?.id}.vm.${helper}.internal`,
    )
  await Bun.sleep(5 * SECOND_MS)
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

const count = Number(option('people', '50'))
const rampS = Number(option('ramp', '120'))
const planChoice = option('plan', 'mix')
const playMinutes = Number(option('play', '5'))
const idleMinutes = Number(option('idle', '1'))
const run = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')
const out = option('out', `local/load-test/${run}`)
const planOf = (i: number): 'free' | 'plus' =>
  planChoice === 'free' || planChoice === 'plus' ? planChoice : i % 2 === 0 ? 'plus' : 'free'
// A friend joins every third server, where its players can play.
const friendOf = (i: number) => i % 3 === 2 && planOf(i) === 'plus'
const headless = Array.from({ length: count }, (_, i) => (friendOf(i) ? 2 : 1)).reduce((a, b) => a + b, 0)
const probeApp = `${PROBE_PREFIX}${run}`
const started = Date.now()

say(`load test ${run}: ${count} people (${planChoice}) over ${rampS}s, ${playMinutes} min of play, at ${WEB}`)
tunnel(18025, MAIL_PORT, 'bly-staging-mail')
const probeCount = Math.ceil(headless / PLAYERS_PER_PROBE)
say(`${probeCount} probes for ${headless} headless players, in ${probeApp}`)
const probes: Probe[] = await probesUp(probeApp, probeCount, databaseHost)
const operator = await admin()
const site = people(WEB, MAILPIT)

const records: StepRecord[] = []
const machines: MachineRun[] = []
const playerRun = {
  id: run,
  domain: DOMAIN,
  key: () => `${KEY_PREFIX}${randomUUID().slice(14)}`,
  signUp: (email: string) => site.person(email),
  sql,
  playMinutes,
  idleMinutes,
  record: (step: StepRecord) => {
    records.push(step)
    if (!step.ok)
      say(`  FAIL ${step.player} ${step.step}: ${step.error}${step.operation ? ` | ${step.operation}` : ''}`)
  },
  beforeTrash: async (serverId: string) => {
    machines.push(...(await machineRuns(appOf(serverId)).catch(() => [])))
  },
}
const players = Array.from(
  { length: count },
  (_, i) =>
    new Player(
      i,
      planOf(i),
      playerRun,
      probes[i % probes.length] as Probe,
      friendOf(i) ? (probes[(i + 1) % probes.length] as Probe) : null,
    ),
)

// ─── Watching it run ─────────────────────────────────────────────────────────────────────────

const peak: Record<string, number> = {}
const atPeak = (what: string, n: number) => {
  peak[what] = Math.max(peak[what] ?? 0, n)
}
async function line(): Promise<string> {
  const of = (phase: string) => players.filter((p) => p.phase === phase).length
  const mine = `accounts ${players.filter((p) => p.accountMade).length}/${count} · servers making ${of('making')}, ready ${of('ready') + of('waking')}, with players ${players.filter((p) => p.hasPlayers).length}, asleep ${of('asleep')}, failed ${players.filter((p) => p.failed).length}, done ${of('done')}`
  const health = await operator('admin.health', {}, 'GET').then(
    // biome-ignore lint/suspicious/noExplicitAny: HealthView, read for a line
    (view: any) => {
      const { running, asleep, busy, failed } = view.now.servers
      const queued = view.now.operations.reduce((sum: number, o: { queued: number }) => sum + o.queued, 0)
      const working = view.now.operations.reduce((sum: number, o: { running: number }) => sum + o.running, 0)
      atPeak('running servers', running)
      atPeak('busy servers', busy)
      atPeak('operations queued', queued)
      atPeak('operations running', working)
      return `health: running ${running}, asleep ${asleep}, busy ${busy}, failed ${failed}; operations queued ${queued}, running ${working}`
    },
    (error: unknown) => `health unread: ${(error as Error).message}`,
  )
  const connections = Number(await sql('select count(*) from pg_stat_activity').catch(() => '0'))
  atPeak('database connections', connections)
  const loads = await Promise.all(
    probes.map((p) =>
      p.load().then(
        (l) => l.load.toFixed(1),
        () => '?',
      ),
    ),
  )
  return `${took(Date.now() - started).padStart(7)}  ${mine} | ${health} | db connections ${connections} | probe load ${loads.join(' ')}`
}
const watching = setInterval(() => void line().then(say), 15 * SECOND_MS)

// ─── People arrive, spread over the ramp ─────────────────────────────────────────────────────

await Promise.all(
  players.map(async (player, i) => {
    await Bun.sleep((i * rampS * SECOND_MS) / Math.max(1, count))
    await player.journey().catch((error: unknown) => {
      say(`  player ${i} stopped: ${(error as Error).message}`)
      player.failed = true
    })
  }),
)
clearInterval(watching)
say(await line())

// ─── Everything the run made, gone ───────────────────────────────────────────────────────────

const made = players.flatMap((p) => p.servers.map((s) => s.id))
say(`\npurging ${made.length} servers`)
const stuck = await purge(made, 900)
const apps = new Set(await serverApps())
const appsLeft = made.map(appOf).filter((app) => apps.has(app))
say(`${made.length - stuck.length} purged; not purged: ${stuck.length}; Fly apps left: ${appsLeft.length}`)
const retries = (await database.unsafe(
  `select kind, count(*)::int as operations,
     count(*) filter (where (select count(*) from jsonb_array_elements(coalesce(steps, '[]'::jsonb)) s where s->>'step' = 'attempt') > 1)::int as retried,
     count(*) filter (where status = 'failed')::int as failed
   from server_operations where server_id in (${made.map((id) => `'${id}'`).join(', ') || 'null'}) group by kind order by kind`,
)) as Array<{ kind: string; operations: number; retried: number; failed: number }>
machines.push(...(await machineRuns(probeApp).catch(() => [])))
await probesDown(probeApp)

const limit = firstLimit(records)
const report = {
  run,
  people: count,
  plan: planChoice,
  startedAt: new Date(started).toISOString(),
  tookMs: Date.now() - started,
  steps: stepStats(records),
  failures: failuresOf(records),
  firstLimit: limit && { limit: limit.limit, step: limit.record.step, error: limit.record.error ?? '' },
  machineHours: hoursBySize(machines),
  peak: { ...peak, ...Object.fromEntries([...refused].map(([path, n]) => [`answers ${path}`, n])) },
  operationRetries: retries,
  records,
}
write(out, report)
say(`\n${markdown(report)}`)
say(`written to ${out}.json and ${out}.md`)
if (stuck.length > 0 || appsLeft.length > 0)
  say(`left behind: ${[...stuck, ...appsLeft].join(', ')}: run \`bun scripts/load-test.ts clean\``)
process.exit(stuck.length === 0 && appsLeft.length === 0 ? 0 : 1)
