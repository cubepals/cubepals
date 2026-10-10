// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Minecraft lifecycle on staging, on Fly, timed. Run it after `bun scripts/staging.ts up`:
 *
 *   bun scripts/staging-check.ts            the whole lifecycle, then the server goes to the trash
 *   bun scripts/staging-check.ts --keep     leaves the account and its server to look at
 *
 * One Free account and one server, taken through what a group does over weeks, with the weeks
 * skipped by moving one timestamp: made and started, joined through the edge, left until it goes to
 * sleep, woken by a join, rested in the archive store with its machine and volume let go, woken from
 * the archive by a join, and checked to be the same world. Then its machine is killed under it, and
 * it's started again. Every wait a player would feel is timed, and every step asserts. Before all
 * that, whatever an earlier run left (a run that failed or was cancelled before its end) is purged.
 *
 * The sleep is the real one, only sooner: the check's own account is given a one-minute idle time
 * (an account's `idleShutdownAfterMinutes` override) for that step alone, so the control plane's
 * own idle check stops the server as it would after the plan's ten minutes, and nothing else on
 * staging changes.
 *
 * While a step waits it says so every 20 seconds, with what it last saw of the server and its
 * machine, and the run ends with a table of every step and its time (`lib/check-progress.ts`).
 *
 * The private parts are reached the way an operator would: Postgres and Mailpit over `fly proxy`,
 * the server's machines and volumes through flyctl, the stored copy through the bucket's own API.
 */
import { spawn } from 'node:child_process'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { SQL } from 'bun'
import { Progress, type StepResult, seconds, summaryTable } from './lib/check-progress.ts'
import { type Edge, join, login } from './lib/minecraft.ts'
import { type Api, people } from './lib/people.ts'

const WEB = 'https://staging.cubepals.com'
const STATE_FILE = 'local/staging/state.json'
const KEEP = process.argv.includes('--keep')

const say = (line: string) => process.stdout.write(`${line}\n`)
/** How long the check's own server stays up with nobody on it, against the Free plan's ten. */
const SLEEP_AFTER_MINUTES = 1

if (!existsSync(STATE_FILE) && !process.env.STAGING_STATE) {
  say('No staging to check: run bun scripts/staging.ts up first.')
  process.exit(2)
}
// A cloud environment carries what `up` made in STAGING_STATE (staging.ts env).
const state = JSON.parse(
  existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : (process.env.STAGING_STATE ?? '{}'),
) as {
  /** Supabase's session pooler, as `up` kept it. */
  databaseUrl: string
  authSecret: string
  bucket: { name: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }
}

// ─── Steps ───────────────────────────────────────────────────────────────────────────────────

const failures: string[] = []
const timings: string[] = []
const results: StepResult[] = []
const progress = new Progress({ write: say })
setInterval(() => progress.tick(), 1000).unref()

async function step(name: string, run: () => Promise<string | undefined>, limitSeconds = 900): Promise<void> {
  const started = Date.now()
  progress.begin()
  try {
    const note = await Promise.race([
      run(),
      new Promise<never>((_, stop) =>
        setTimeout(() => stop(new Error(`gave up after ${limitSeconds}s`)), limitSeconds * 1000).unref(),
      ),
    ])
    progress.end()
    results.push({ name, ok: true, ms: Date.now() - started })
    say(`  ok   ${name}${note ? ` — ${note}` : ''}  (${seconds(Date.now() - started)})`)
  } catch (error) {
    progress.end()
    failures.push(name)
    results.push({ name, ok: false, ms: Date.now() - started })
    say(`  FAIL ${name} — ${(error as Error).message}  (${seconds(Date.now() - started)})`)
  }
}
function check(held: boolean, complaint: string): void {
  if (!held) throw new Error(complaint)
}
const timed = (what: string, ms: number) => {
  timings.push(`${what}: ${seconds(ms)}`)
  return seconds(ms)
}

// ─── The private parts ───────────────────────────────────────────────────────────────────────

/** `fly proxy` to an app's private port, for as long as this runs. */
function proxy(local: number, remote: number, app: string): void {
  const child = spawn('fly', ['proxy', `${local}:${remote}`, '-a', app], { stdio: 'ignore' })
  process.on('exit', () => child.kill())
}

function fly(args: string[]): string {
  const result = Bun.spawnSync(['fly', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`fly ${args.slice(0, 3).join(' ')}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

const database = new SQL(state.databaseUrl)
/** One statement against staging's database; what it answers is the first column of its first row. */
async function sql(statement: string): Promise<string> {
  const [row] = (await database.unsafe(statement).values()) as unknown[][]
  return row?.[0] == null ? '' : String(row[0])
}

const bucket = new S3Client({
  endpoint: state.bucket.endpoint,
  region: state.bucket.region,
  credentials: { accessKeyId: state.bucket.accessKeyId, secretAccessKey: state.bucket.secretAccessKey },
})

/** The Fly app a server runs in: `bly-<deployment>-<its id without dashes>`. */
const appOf = (serverId: string) => `bly-staging-${serverId.replaceAll('-', '')}`
const machinesOf = (serverId: string) =>
  (JSON.parse(fly(['machines', 'list', '-a', appOf(serverId), '--json']) || '[]') ?? []) as {
    id: string
    name: string
    state: string
  }[]
/**
 * What Fly last said of the server's machines, for progress lines. It is read in the background,
 * at most every 15 seconds, so a wait being timed (a join) is never held up by flyctl.
 */
const flySeen = { text: '', at: 0, reading: false }
function readFly(serverId: string): void {
  if (serverId === '' || flySeen.reading || Date.now() - flySeen.at < 15_000) return
  flySeen.reading = true
  const child = Bun.spawn(['fly', 'machines', 'list', '-a', appOf(serverId), '--json'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  Promise.all([new Response(child.stdout).text(), child.exited])
    .then(([out, code]) => {
      if (code !== 0) return
      const states = ((JSON.parse(out || '[]') ?? []) as { state: string }[]).map((m) => m.state)
      flySeen.text = `Fly: ${states.length === 0 ? 'no machine' : states.join(', ')}`
    })
    .catch(() => undefined)
    .finally(() => {
      flySeen.at = Date.now()
      flySeen.reading = false
    })
}
const volumesOf = (serverId: string) =>
  (JSON.parse(fly(['volumes', 'list', '-a', appOf(serverId), '--json']) || '[]') ?? []) as {
    id: string
    name: string
    state: string
    size_gb: number
  }[]

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

proxy(18025, 8025, 'bly-staging-mail')
const edgeV4 = (
  JSON.parse(fly(['ips', 'list', '-a', 'bly-staging-edge', '--json'])) as { Address: string; Type: string }[]
).find((ip) => ip.Type === 'v4')?.Address
if (!edgeV4) {
  say('The edge has no IPv4.')
  process.exit(2)
}
const EDGE: Edge = { host: edgeV4, port: 25565 }
const PLAY_DOMAIN = 'play.staging.cubepals.com'
// The proxies come up in a moment.
for (let i = 0; i < 30; i++) {
  const ready = await fetch('http://127.0.0.1:18025/api/v1/info').then(
    (r) => r.ok,
    () => false,
  )
  if (ready) break
  await Bun.sleep(1000)
}

const started = Date.now()
say(`staging check: ${WEB}, players at <server>.${PLAY_DOMAIN}`)
let api: Api = async () => {
  throw new Error('no account yet')
}
let owner = { email: '', password: '' }
let server = { id: '', slug: '' }
const view = (serverId: string) => api('servers.get', { serverId }, 'GET')
/** What a progress line says of the server: its state, the operation on it, and Fly's machines. */
// biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as waitFor reads it
function sawServer(v: any): void {
  const op = v.activeOperation
  const reason = v.status === 'stopped' && v.stopReason ? ` (${v.stopReason})` : ''
  const operation = op ? `, ${op.kind}: ${op.step ?? op.status}` : ''
  readFly(server.id)
  progress.saw(`server ${v.status}${reason}${operation}${flySeen.text ? ` | ${flySeen.text}` : ''}`)
}
// biome-ignore lint/suspicious/noExplicitAny: the app's own contracts, read loosely as in the smoke test
async function waitFor(want: (v: any) => boolean, what: string, limit = 600): Promise<any> {
  progress.waiting(what)
  const deadline = Date.now() + limit * 1000
  while (Date.now() < deadline) {
    const now = await view(server.id)
    if (want(now)) return now
    sawServer(now)
    await Bun.sleep(2000)
  }
  throw new Error(`never ${what} within ${limit}s`)
}
/** A wait on something other than the server's state (a join), with the server watched meanwhile. */
async function watching<T>(what: string, wait: Promise<T>): Promise<T> {
  progress.waiting(what)
  let over = false
  const watch = async () => {
    while (!over) {
      await view(server.id).then(sawServer, () => undefined)
      await Bun.sleep(5000)
    }
  }
  void watch()
  try {
    return await wait
  } finally {
    over = true
  }
}
const settled = (limit = 600) => waitFor((v) => v.activeOperation === null, 'settled', limit)
const address = () => `${server.slug}.${PLAY_DOMAIN}`
const consoleSays = async (command: string) =>
  String((await api('console.run', { serverId: server.id, command })).output ?? '')
const seedOf = async () => (await consoleSays('seed')).match(/-?\d+/)?.[0] ?? ''
const markOf = async () =>
  (await consoleSays('scoreboard players get check blockly_check')).match(/has (-?\d+)/)?.[1] ?? ''
/** How long an operation of this kind last took, from its own record. */
const tookOf = (kind: string) =>
  sql(
    `select round(extract(epoch from (finished_at - created_at))::numeric, 1) from server_operations where server_id = '${server.id}' and kind = '${kind}' and status = 'succeeded' order by created_at desc limit 1`,
  )

/** A server's Fly app, `bly-staging-` and its id's 32 hex digits, back to that id. */
function serverIdOf(app: string): string | undefined {
  const hex = /^bly-staging-([0-9a-f]{32})$/.exec(app)?.[1]
  return (
    hex && `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  )
}

// A run that stops before its end leaves its server, and its volume, behind; staging's control
// plane runs a few minutes a night, too briefly for its own sweeps to catch it. Earlier runs'
// servers go through the same purge as this run's own, and a server app no server holds goes too.
say('\nwhat earlier runs left')
await step('is purged, and Fly holds no server app without a server', async () => {
  const left = (await database.unsafe(
    `select s.id from minecraft_servers s join users u on u.id = s.owner_id
      where u.email like '%.check.staging.blockly.test' and s.status <> 'purged'`,
  )) as { id: string }[]
  if (left.length > 0) {
    const ids = left.map(({ id }) => `'${id}'`).join(', ')
    await sql(
      `update minecraft_servers set status = 'deleted', deleted_at = coalesce(deleted_at, now()),
         purge_after = now() - interval '1 minute' where id in (${ids})`,
    )
    await sql(
      `insert into pgboss.job (name, data, policy, retry_limit) values ('purge-sweep', '{}', 'singleton', 0)`,
    )
    const waiting = () =>
      sql(`select count(*) from minecraft_servers where id in (${ids}) and status <> 'purged'`)
    progress.waiting('earlier servers purged')
    const deadline = Date.now() + 600_000
    for (let now = await waiting(); now !== '0' && Date.now() < deadline; now = await waiting()) {
      progress.saw(`${now} of ${left.length} not purged yet`)
      await Bun.sleep(5000)
    }
    check((await waiting()) === '0', `${await waiting()} of ${left.length} not purged`)
  }
  const apps = (
    JSON.parse(fly(['apps', 'list', '-o', 'blockly-staging', '--json'])) as { Name: string }[]
  ).map((app) => app.Name)
  const unheld: string[] = []
  for (const app of apps) {
    const id = serverIdOf(app)
    if (id === undefined) continue
    const status = await sql(`select status from minecraft_servers where id = '${id}'`)
    if (status !== '' && status !== 'purged') continue
    fly(['apps', 'destroy', app, '--yes'])
    unheld.push(app)
  }
  return `${left.length} servers purged, ${unheld.length} apps without a server destroyed`
})

say('\nthe account')
await step('signs up on staging and confirms through its mail catcher', async () => {
  // Staging lets only its allowlist make accounts; this domain is on it, and private to its state
  // (staging.ts derives the same one).
  const domain = `${createHash('sha256').update(state.authSecret).digest('hex').slice(0, 12)}.check.staging.blockly.test`
  const email = `check-${Date.now()}@${domain}`
  const them = await people(WEB, 'http://127.0.0.1:18025').person(email)
  owner = { email: them.email, password: them.password }
  api = them.api
  const { entitlements } = await api('account.overview', {}, 'GET')
  check(entitlements.plan === 'free', `plan is ${entitlements.plan}`)
  return email
})
if (owner.email === '') process.exit(1)

say('\nthe server')
let world = { seed: '', mark: '' }
await step('is made on Fly and comes up', async () => {
  const at = Date.now()
  const created = await api('servers.create', {
    idempotencyKey: randomUUID(),
    name: 'Staging Check',
    playStyle: 'survival',
    partySize: '5',
    regionKey: 'eu',
    loader: 'vanilla',
  })
  server = { id: created.id, slug: created.slug }
  const up = await waitFor((v) => v.status === 'running', 'came up', 900)
  const took = timed('first start (new app, volume and machine, image pulled, world made)', Date.now() - at)
  await settled()
  const machines = machinesOf(server.id)
  check(
    machines.some((m) => m.state === 'started'),
    `Fly shows ${machines.map((m) => m.state).join(', ')}`,
  )
  return `${up.memoryTier} in ${took}; Fly: ${machines.length} machine, ${volumesOf(server.id)
    .map((v) => `${v.size_gb} GB`)
    .join(', ')}`
})
if (server.id === '') process.exit(1)

await step('answers a player through the edge, at its own address', async () => {
  const took = await watching('a player answered', join(EDGE, address(), 'StagingCheck', 60_000))
  const said = await login(EDGE, address(), 'StagingCheck')
  check(said === 'wants an account', `the server said "${said}"`)
  return `${address()} answered in ${timed('join while running', took)}, and asks for an account`
})

await step('keeps what is written into its world', async () => {
  world.seed = await seedOf()
  check(world.seed !== '', 'the server would not say its seed')
  const mark = String(randomInt(1, 1_000_000))
  await consoleSays('scoreboard objectives add blockly_check dummy')
  await consoleSays(`scoreboard players set check blockly_check ${mark}`)
  await consoleSays('save-all flush')
  world = { ...world, mark: await markOf() }
  check(world.mark === mark, `the mark reads "${world.mark}"`)
  return `seed ${world.seed}, mark ${mark}`
})

await step(
  'goes to sleep on its own when nobody plays',
  async () => {
    // The control plane's own idle check, on this account's idle time rather than the plan's.
    // Whatever happens, the account goes back to its plan's after this step, so nothing later in
    // the run is put to sleep under it.
    const account = `user_id = (select id from users where email = '${owner.email}')`
    await sql(
      `update account_standing set limit_overrides = limit_overrides || '{"idleShutdownAfterMinutes": ${SLEEP_AFTER_MINUTES}}' where ${account}`,
    )
    try {
      const at = Date.now()
      const asleep = await waitFor((v) => v.status === 'stopped', 'went to sleep', 1500)
      await settled()
      check(asleep.stopReason === 'idle', `it stopped for ${asleep.stopReason}`)
      const machines = machinesOf(server.id)
      check(
        machines.every((m) => m.state === 'stopped'),
        `Fly shows ${machines.map((m) => m.state).join(', ')}`,
      )
      const volumes = volumesOf(server.id).filter(
        (v) => v.state !== 'destroyed' && v.state !== 'pending_destroy',
      )
      check(volumes.length > 0, 'Fly kept no volume for it')
      return `after ${seconds(Date.now() - at)} of waiting, idle after ${SLEEP_AFTER_MINUTES} min on this account; its machine is stopped, its volume kept`
    } finally {
      await sql(
        `update account_standing set limit_overrides = limit_overrides - 'idleShutdownAfterMinutes' where ${account}`,
      )
    }
  },
  1600,
)

await step('wakes when a player joins', async () => {
  const took = await watching('a joining player answered', join(EDGE, address(), 'StagingWaker', 300_000))
  await waitFor((v) => v.status === 'running', 'woke', 300)
  await settled()
  return `the player waited ${timed('wake from sleep (machine started)', took)}`
})

await step('rests in the archive store once nobody has played for weeks, and lets go of Fly', async () => {
  await api('servers.stop', { serverId: server.id, requestId: randomUUID() })
  await waitFor((v) => v.status === 'stopped', 'stopped', 300)
  await settled()
  // Two weeks without play, as far as the sweep can tell, then the sweep itself, rather than
  // waiting for its hour.
  await sql(
    `update minecraft_servers set last_active_at = now() - interval '15 days' where id = '${server.id}'`,
  )
  await sql(
    `insert into pgboss.job (name, data, policy, retry_limit) values ('store-sweep', '{}', 'singleton', 0)`,
  )
  const stored = await waitFor((v) => v.status === 'stored', 'rested', 1200)
  check(stored.status === 'stored', `it is ${stored.status}`)
  const machines = machinesOf(server.id)
  const volumes = volumesOf(server.id).filter((v) => v.state !== 'destroyed' && v.state !== 'pending_destroy')
  check(machines.length === 0, `Fly still has ${machines.map((m) => `${m.name} ${m.state}`).join(', ')}`)
  check(volumes.length === 0, `Fly still has ${volumes.map((v) => `${v.name} ${v.state}`).join(', ')}`)
  const key = await sql(
    `select archive_key from backups where server_id = '${server.id}' and trigger = 'stored' and status = 'ready' order by created_at desc limit 1`,
  )
  check(key !== '', 'no stored copy is recorded')
  const head = await bucket.send(new HeadObjectCommand({ Bucket: state.bucket.name, Key: key }))
  return `stored in ${timed('rest (snapshot, export to the bucket, release)', Number(await tookOf('store')) * 1000)}; no machine or volume left; the copy is ${((head.ContentLength ?? 0) / 2 ** 20).toFixed(1)} MB`
})

await step('comes back from the archive when a player joins', async () => {
  const took = await watching('a joining player answered', join(EDGE, address(), 'StagingWaker', 900_000))
  await waitFor((v) => v.status === 'running', 'came back', 600)
  await settled()
  const restore = Number(await tookOf('unstore')) * 1000
  return `the player waited ${timed('wake from rest (new volume, copy downloaded and unpacked, boot)', took)}; the restore itself took ${seconds(restore)}`
})

await step('is the same world', async () => {
  const seed = await seedOf()
  const mark = await markOf()
  check(seed === world.seed, `the seed was ${world.seed} and is ${seed}`)
  check(mark === world.mark, `the mark was ${world.mark} and is ${mark}`)
  return `seed ${seed}, mark ${mark}`
})

await step('comes back after its machine is killed under it', async () => {
  const machine = machinesOf(server.id).find((m) => m.state === 'started')
  check(machine !== undefined, 'no machine is running')
  fly(['machine', 'kill', machine?.id ?? '', '-a', appOf(server.id)])
  const at = Date.now()
  // Fly restarts a machine whose process died (the restart policy is on-failure), so it's back
  // without Blockly doing anything; had Fly given up, Blockly would see it stopped and start it.
  await Bun.sleep(5000)
  const seen = await view(server.id)
  if (seen.status === 'stopped' || seen.status === 'crashed')
    await api('servers.start', { serverId: server.id, requestId: randomUUID() })
  await watching('a player answered', join(EDGE, address(), 'StagingCheck', 300_000))
  const took = Date.now() - at
  await waitFor((v) => v.status === 'running', 'running again', 300)
  check((await seedOf()) === world.seed, 'it came back as another world')
  return `answering players again ${timed('back after a crash (Fly restarts the machine)', took)} after the kill, the same world${seen.status === 'running' ? ', without Blockly having to start it' : `, started by Blockly after it saw ${seen.status}`}`
})

if (KEEP) say(`\nkept: ${owner.email} / ${owner.password}, server ${server.id}`)
else
  await step('goes to the trash: its machine goes, its volume stays', async () => {
    await api('servers.delete', { serverId: server.id, confirmName: 'Staging Check' })
    await waitFor((v) => v.activeOperation === null && v.status === 'deleted', 'deleted', 300).catch(
      () => undefined,
    )
    const machines = machinesOf(server.id)
    return `Fly: ${machines.length} machines, ${volumesOf(server.id).length} volume kept for the trash`
  })

// Staging's control plane is stopped between runs, so its own sweep would never empty this trash:
// each run would leave a volume behind. Its time in the trash is up, then the sweep runs now.
if (!KEEP)
  await step('is purged once its time in the trash is up, and Fly holds nothing of it', async () => {
    await sql(
      `update minecraft_servers set purge_after = now() - interval '1 minute' where id = '${server.id}'`,
    )
    await sql(
      `insert into pgboss.job (name, data, policy, retry_limit) values ('purge-sweep', '{}', 'singleton', 0)`,
    )
    const status = () => sql(`select status from minecraft_servers where id = '${server.id}'`)
    progress.waiting('purged')
    const deadline = Date.now() + 600_000
    for (let now = await status(); now !== 'purged' && Date.now() < deadline; now = await status()) {
      progress.saw(`server ${now}`)
      await Bun.sleep(5000)
    }
    check((await status()) === 'purged', `it is ${await status()}`)
    const app = fly(['apps', 'list', '-o', 'blockly-staging', '--json'])
    check(!app.includes(appOf(server.id)), `Fly still has ${appOf(server.id)}`)
    return `purged by the sweep; its Fly app, machine and volume are gone`
  })

say(`\n${timings.map((line) => `  ${line}`).join('\n')}`)
say(`\n${summaryTable(results, Date.now() - started).join('\n')}`)
const summary = failures.length === 0 ? 'all good' : `${failures.length} failed: ${failures.join(', ')}`
say(`\n${summary} in ${seconds(Date.now() - started)}`)
process.exit(failures.length === 0 ? 0 : 1)
