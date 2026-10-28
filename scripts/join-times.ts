// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long a join takes on staging, as the player feels it, with the real clients: Java
 * (mineflayer, `lib/players-probe.ts`'s `join`) and Bedrock (`tools/bedrock-join`). Run it after
 * `bun scripts/staging.ts start`, from a machine that can send UDP (the Join times workflow's
 * runner), with the edge's Xbox sign-in check off for Bedrock, as the Bedrock E2E workflow has it:
 *
 *   bun scripts/join-times.ts [--n 5] [--templates arcade,duels] [--states awake,sleep,cold,rest]
 *                             [--clients java,bedrock]
 *
 * For each template it makes a server as Cubepals runs its own (marked official, account checks
 * off so a client with no account gets in), then for each state and client joins it `n` times,
 * putting it in that state before every join:
 *
 *   awake  running, nobody on
 *   sleep  stopped by its owner, as the idle check stops it: suspended where staging suspends
 *   cold   asleep, with its machine stopped, as Fly dropping its memory leaves it
 *   rest   in the archive store, its machine and volume let go
 *
 * Each player stays in the world past the control plane's presence reading, so its wake counts as
 * joined. Each join prints one JSON line; the run ends with a table of the time from the connection to
 * the player in the world (Java: the client's spawn; Bedrock: its spawn), n, p50 and p90, by
 * template, state and client, and the server-list lines the Java client saw while it waited.
 * Then the servers go to the trash and are purged.
 *
 * Not for asserting a limit: the staging check does that. Not for production, whose servers check
 * accounts.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { SECOND_MS } from '@blockly/contracts/durations'
import { SQL } from 'bun'
import { runScheduledNow } from '../apps/control/src/infra/pg/jobs.ts'
import { fly } from './lib/fly-async.ts'
import { type Api, people } from './lib/people.ts'
import { restNow } from './lib/rest-now.ts'
import { reachDatabase } from './lib/staging-database.ts'

const WEB = 'https://staging.cubepals.com'
const PLAY_DOMAIN = 'play.staging.cubepals.com'
const MAIL_PORT_HERE = 18035
const STATES = ['awake', 'sleep', 'cold', 'rest'] as const
type State = (typeof STATES)[number]
const CLIENTS = ['java', 'bedrock'] as const
type Client = (typeof CLIENTS)[number]
/** The Java version the probe speaks; Cubepals' own Paper servers take it through their Via plugins. */
const JAVA_VERSION = '1.21.11'
/** The longest one join may take, a wake from the archive store included. */
const JOIN_SECONDS = 300
/**
 * How long each player stays in the world: past the control plane's presence reading, once a
 * minute, so the server sees them on. A woken run nobody was seen on counts toward the server's
 * hourly cap on wakes from connections (`AbuseLimits.wakesPerHour`), and a run of joins would
 * soon be refused as asleep.
 */
const STAY_SECONDS = 70

const { values } = parseArgs({
  options: {
    n: { type: 'string', default: '5' },
    templates: { type: 'string', default: 'arcade,duels' },
    states: { type: 'string', default: STATES.join(',') },
    clients: { type: 'string', default: CLIENTS.join(',') },
  },
})
const runs = Number(values.n)
const templates = (values.templates ?? '').split(',').filter(Boolean)
const states = (values.states ?? '')
  .split(',')
  .filter((s): s is State => (STATES as readonly string[]).includes(s))
const clients = (values.clients ?? '')
  .split(',')
  .filter((c): c is Client => (CLIENTS as readonly string[]).includes(c))

const say = (line: string) => process.stdout.write(`${line}\n`)
const state = JSON.parse(
  process.env.STAGING_STATE ??
    (existsSync('local/staging/state.json') ? readFileSync('local/staging/state.json', 'utf8') : '{}'),
)
if (!state.authSecret) {
  say('No staging to time: run bun scripts/staging.ts up first.')
  process.exit(2)
}

const reached = await reachDatabase(state)
const database = new SQL(reached.url)
const sql = (statement: string) => database.unsafe(statement) as Promise<Record<string, unknown>[]>
const mail = spawn('fly', ['proxy', `${MAIL_PORT_HERE}:8025`, '-a', 'bly-staging-mail'], { stdio: 'ignore' })
process.on('exit', () => mail.kill())

// Staging lets only its allowlist make accounts; the staging check's domain is on it (staging.ts
// derives the same one). This run's servers carry a mark of their own in their create key, so a
// run cut short leaves servers a later one purges, and never anyone else's.
const DOMAIN = `${createHash('sha256').update(state.authSecret).digest('hex').slice(0, 12)}.check.staging.blockly.test`
const MARK = createHash('sha256').update(`join-times:${state.authSecret}`).digest('hex')
const KEY_PREFIX = `${MARK.slice(0, 8)}-${MARK.slice(8, 12)}-`

interface Made {
  template: string
  id: string
  slug: string
  api: Api
}

// biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as the staging check reads it
async function waitFor(made: Made, want: (view: any) => boolean, what: string, limitSeconds = 900) {
  const deadline = Date.now() + limitSeconds * 1000
  // biome-ignore lint/suspicious/noExplicitAny: as above
  let view: any
  while (Date.now() < deadline) {
    view = await made.api('servers.get', { serverId: made.id }, 'GET')
    if (want(view)) return view
    await Bun.sleep(2000)
  }
  throw new Error(`${made.template} never ${what}: ${view?.status}, ${JSON.stringify(view?.activeOperation)}`)
}
const settled = (made: Made) => waitFor(made, (v) => v.activeOperation === null, 'settled')

/** An account of Cubepals' own, on a plan that runs the template, and its server made from it, up. */
async function make(template: string): Promise<Made> {
  for (let i = 0; i < 30; i++) {
    if (
      await fetch(`http://127.0.0.1:${MAIL_PORT_HERE}/api/v1/info`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break
    await Bun.sleep(1000)
  }
  const email = `join-times-${template}-${Date.now()}@${DOMAIN}`
  const { api } = await people(WEB, `http://127.0.0.1:${MAIL_PORT_HERE}`).person(email)
  const account = `user_id = (select id from users where email = '${email}')`
  await sql(`update account_standing set test_account = true where ${account}`)
  const offered = (await api('servers.createOptions', {}, 'GET')).templates as {
    key: string
    fits: { allowed: boolean; plan?: string | null }
  }[]
  const fits = offered.find((t) => t.key === template)?.fits
  if (fits === undefined) throw new Error(`staging does not offer ${template}`)
  if (!fits.allowed) await sql(`update account_standing set plan = '${fits.plan}' where ${account}`)
  const created = await api('servers.create', {
    idempotencyKey: `${KEY_PREFIX}${randomUUID().slice(14)}`,
    name: `Join times ${template}`,
    partySize: '5',
    regionKey: 'eu',
    from: { kind: 'template', key: template },
  })
  const made: Made = { template, id: created.id, slug: created.slug, api }
  await waitFor(made, (v) => v.status === 'running' && v.activeOperation === null, 'came up')
  // As Cubepals runs its own: official, and account checks off for a client with no account.
  await sql(
    `insert into public_listings (server_id, official) values ('${made.id}', true) on conflict (server_id) do update set official = true`,
  )
  const { version } = await api('servers.get', { serverId: made.id }, 'GET')
  await api('servers.changeAuthentication', {
    serverId: made.id,
    requestId: randomUUID(),
    version,
    onlineMode: false,
  })
  await waitFor(made, (v) => v.status === 'running' && v.activeOperation === null, 'started again')
  say(`${template}: ${made.slug}.${PLAY_DOMAIN} up, official, account checks off`)
  return made
}

const appOf = (id: string) => `bly-staging-${id.replaceAll('-', '')}`
const machines = async (id: string) =>
  (JSON.parse((await fly(['machines', 'list', '-a', appOf(id), '--json'])) || '[]') ?? []) as {
    id: string
    state: string
  }[]

/** The server put in `wanted`; what Fly holds of it then, in a word. */
async function into(made: Made, wanted: State): Promise<string> {
  await settled(made)
  const view = await made.api('servers.get', { serverId: made.id }, 'GET')
  if (wanted === 'awake') {
    if (view.status !== 'running') {
      await made.api('servers.start', { serverId: made.id, requestId: randomUUID() })
      await waitFor(made, (v) => v.status === 'running' && v.activeOperation === null, 'started')
    }
    return 'running'
  }
  if (view.status === 'running') {
    await made.api('servers.stop', { serverId: made.id, requestId: randomUUID() })
    await waitFor(made, (v) => v.status === 'stopped' && v.activeOperation === null, 'went to sleep', 600)
  }
  if (wanted === 'cold')
    for (const machine of await machines(made.id))
      if (machine.state === 'suspended') await fly(['machine', 'stop', machine.id, '-a', appOf(made.id)])
  if (wanted === 'rest') {
    // Weeks without play, as far as the sweep can tell, then the sweep itself, once the backup and
    // the archive the stop left are done, as the staging check rests one.
    await restNow({
      sql,
      sweep: () => runScheduledNow(reached.nodeUrl, 'store-sweep'),
      serverId: made.id,
      idleDays: 40,
      limitMs: 1500 * SECOND_MS,
      note: (line) => say(`${made.template}: ${line}`),
    })
    await waitFor(made, (v) => v.status === 'stored' && v.activeOperation === null, 'rested', 300)
    return 'stored'
  }
  return [...new Set((await machines(made.id)).map((m) => m.state))].join(',')
}

/** One client's join, as the last JSON line it printed. */
async function joinOnce(client: Client, address: string, name: string): Promise<Record<string, unknown>> {
  const args =
    client === 'java'
      ? [
          'bun',
          'scripts/lib/players-probe.ts',
          'join',
          address,
          name,
          JAVA_VERSION,
          String(JOIN_SECONDS),
          String(STAY_SECONDS),
        ]
      : [
          'bun',
          'tools/bedrock-join/join.ts',
          '--address',
          address,
          '--username',
          name,
          '--hold',
          String(STAY_SECONDS),
          '--timeout',
          String(JOIN_SECONDS),
        ]
  const run = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(run.stdout).text()
  await run.exited
  const last = out
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .at(-1)
  return last === undefined
    ? { error: (await new Response(run.stderr).text()).slice(-300) }
    : JSON.parse(last)
}

/** From the connection to the player in the world, in ms; null when the join didn't get there. */
function inWorldMs(client: Client, result: Record<string, unknown>): number | null {
  if (client === 'java') return ((result.steps ?? {}) as Record<string, number>).spawned ?? null
  return ((result.spawnMs ?? []) as (number | null)[])[0] ?? null
}

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
const secondsOf = (ms: number) => (ms / 1000).toFixed(1)

const made: Made[] = []
const rows: string[] = []
let failures = 0
const lines = new Map<string, Set<string>>()
try {
  for (const template of templates) made.push(await make(template))
  for (const server of made)
    for (const wanted of states)
      for (const client of clients) {
        const times: number[] = []
        let failed = 0
        for (let i = 0; i < runs; i++) {
          const held = await into(server, wanted)
          const name = client === 'java' ? `JoinTimes${i}` : `bedrocktimes${i}`
          const result = await joinOnce(client, `${server.slug}.${PLAY_DOMAIN}`, name)
          say(JSON.stringify({ template: server.template, state: wanted, client, held, ...result }))
          const ms = inWorldMs(client, result)
          if (ms === null) {
            failed++
            failures++
          } else times.push(ms)
          for (const seen of (result.lines ?? []) as { line: string }[]) {
            const key = `${server.template} ${wanted}`
            lines.set(key, (lines.get(key) ?? new Set()).add(seen.line.replaceAll('\n', ' / ')))
          }
        }
        const sorted = times.sort((a, b) => a - b)
        rows.push(
          `| ${server.template} | ${wanted} | ${client} | ${times.length}${failed ? ` (${failed} failed)` : ''} | ${times.length ? secondsOf(percentile(sorted, 50)) : '-'} | ${times.length ? secondsOf(percentile(sorted, 90)) : '-'} |`,
        )
      }
} finally {
  say('\n| Server | State | Client | n | p50 (s) | p90 (s) |\n| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) say(row)
  say("\nWhat the Java client's server list said while it waited:")
  for (const [key, seen] of lines) say(`- ${key}: ${[...seen].join(' → ')}`)
  for (const server of made) {
    const view = await server.api('servers.get', { serverId: server.id }, 'GET').catch(() => null)
    if (view)
      await server
        .api('servers.delete', { serverId: server.id, confirmName: view.name })
        .catch(() => undefined)
  }
  // Whatever got made, a server whose making failed partway included: every server with this
  // run's mark that isn't purged yet goes to the trash and the purge.
  const left = await sql(
    `update minecraft_servers set status = 'deleted', deleted_at = coalesce(deleted_at, now()), purge_after = now() - interval '1 minute'
     where create_idempotency_key like '${KEY_PREFIX}%' and status <> 'purged' returning id`,
  )
  await runScheduledNow(reached.nodeUrl, 'purge-sweep')
  say(`\n${left.length} servers to the trash and the purge`)
  await database.close()
}
// A join that didn't reach the world is a run to look at, whatever the table shows.
process.exit(failures > 0 ? 1 : 0)
