// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Minecraft lifecycle on staging, on Fly, timed. Run it after `bun scripts/staging.ts up`:
 *
 *   bun scripts/staging-check.ts            the whole lifecycle, then the servers go to the trash
 *   bun scripts/staging-check.ts --keep     leaves the accounts and their servers to look at
 *
 * What a group does with a server over weeks, with the weeks skipped by moving one timestamp, split
 * into three journeys that run at once, each on its own Free account and server, since none needs
 * what another does:
 *
 *   sleep   made, joined through the edge, left until it goes to sleep, woken by a join
 *   rest    made, written into, rested in the archive store with its machine and volume let go,
 *           woken from the archive by a join, and checked to be the same world
 *   crash   made, its machine killed under it, and back as the same world
 *
 * and one more for each of Cubepals' own templates, each template whose setup carries a datapack
 * Cubepals writes (the Arcade and Duels), found from the templates themselves: made from it and
 * booted cold, as a player's first server of it is, its own datapack enabled and answering its load
 * function on the console, then asleep and woken with nothing changed. Its journey is named by the
 * template's key, so a failure names the template and the step.
 *
 * Then each goes to the trash, and the trash is purged. Every wait a player would feel is timed,
 * and every step asserts. Before all that, whatever an earlier run left (a run that failed or was
 * cancelled before its end) is purged.
 *
 * The sleep is the real one, only sooner: the sleep journey's account is given a one-minute idle
 * time (an account's `idleShutdownAfterMinutes` override) for that step alone, so the control
 * plane's own idle check stops the server as it would after the plan's ten minutes, and nothing
 * else on staging changes. Its wait is mostly the control plane's own grace after a restart
 * (`IDLE_GRACE_MS`), which the deploy just before started.
 *
 * Every line a journey prints starts with its name. While a step waits it says so every 20
 * seconds, with what it last saw of the server and its machine, and the run ends with one table of
 * every journey's steps and their times (`lib/check-progress.ts`).
 *
 * The private parts are reached the way an operator would: Postgres and Mailpit over `fly proxy`,
 * the servers' machines and volumes through flyctl, the stored copy through the bucket's own API.
 */
import { spawn } from 'node:child_process'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { MAIL_PORT } from '@blockly/contracts/local'
import { SQL } from 'bun'
import { TEMPLATES } from '../apps/control/src/app/setups/templates.ts'
import { runScheduledNow } from '../apps/control/src/infra/pg/jobs.ts'
import { GAME_PORT } from '../apps/control/src/minecraft/ports.ts'
import { Progress, type StepResult, seconds, summaryTable } from './lib/check-progress.ts'
import { type Edge, join, login } from './lib/minecraft.ts'
import { ownGameJoins } from './lib/own-game-joins.ts'
import { type Api, people } from './lib/people.ts'
import { verifiedAgainstSupabase } from './lib/supabase-root.ts'

const WEB = 'https://staging.cubepals.com'
const STATE_FILE = 'local/staging/state.json'
const KEEP = process.argv.includes('--keep')

const say = (line: string) => process.stdout.write(`${line}\n`)
/** How long the sleep journey's server stays up with nobody on it, against the Free plan's ten. */
const SLEEP_AFTER_MINUTES = 1
/**
 * The longest a join may wait to wake a server from Fly's suspend. A resume measured about 1.5 s
 * from the call to a player spawned; ten times that is
 * room for a slow edge or Fly, while a wake held up behind other work, as one was behind a restore
 * point's snapshot at 67.5 s, fails.
 */
const SUSPENDED_WAKE_LIMIT_MS = 15_000

if (!existsSync(STATE_FILE) && !process.env.STAGING_STATE) {
  say('No staging to check: run bun scripts/staging.ts up first.')
  process.exit(2)
}
// A cloud environment carries what `up` made in STAGING_STATE (staging.ts env).
const state = JSON.parse(
  existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : (process.env.STAGING_STATE ?? '{}'),
) as {
  /** Supabase's session pooler, as `up` kept it; a cloud environment has it as STAGING_DATABASE_URL. */
  databaseUrl?: string
  authSecret: string
  bucket: { name: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }
}

// ─── The private parts ───────────────────────────────────────────────────────────────────────

/** `fly proxy` to an app's private port, for as long as this runs. */
function proxy(local: number, remote: number, app: string): void {
  const child = spawn('fly', ['proxy', `${local}:${remote}`, '-a', app], { stdio: 'ignore' })
  process.on('exit', () => child.kill())
}

/** flyctl, without holding up the other journeys while it answers. */
async function fly(args: string[]): Promise<string> {
  const child = Bun.spawn(['fly', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`fly ${args.slice(0, 3).join(' ')}: ${err.trim()}`)
  return out
}

const databaseUrl = state.databaseUrl ?? process.env.STAGING_DATABASE_URL ?? ''
const database = new SQL(databaseUrl)
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
const machinesOf = async (serverId: string) =>
  (JSON.parse((await fly(['machines', 'list', '-a', appOf(serverId), '--json'])) || '[]') ?? []) as {
    id: string
    name: string
    state: string
  }[]
const volumesOf = async (serverId: string) =>
  (JSON.parse((await fly(['volumes', 'list', '-a', appOf(serverId), '--json'])) || '[]') ?? []) as {
    id: string
    name: string
    state: string
    size_gb: number
  }[]
const keptVolumes = async (serverId: string) =>
  (await volumesOf(serverId)).filter((v) => v.state !== 'destroyed' && v.state !== 'pending_destroy')
const serverApps = async () =>
  (JSON.parse(await fly(['apps', 'list', '-o', 'blockly-staging', '--json'])) as { Name: string }[]).map(
    (app) => app.Name,
  )

/** Asks for a sweep now rather than on its schedule: a worker takes it within the minute. */
const sweep = (job: 'purge-sweep' | 'store-sweep') =>
  runScheduledNow(verifiedAgainstSupabase(databaseUrl), job)

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

proxy(18025, MAIL_PORT, 'bly-staging-mail')
const edgeV4 = (
  JSON.parse(await fly(['ips', 'list', '-a', 'bly-staging-edge', '--json'])) as {
    Address: string
    Type: string
  }[]
).find((ip) => ip.Type === 'v4')?.Address
if (!edgeV4) {
  say('The edge has no IPv4.')
  process.exit(2)
}
const EDGE: Edge = { host: edgeV4, port: GAME_PORT }
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
// Staging lets only its allowlist make accounts; this domain is on it, and private to its state
// (staging.ts derives the same one).
const CHECK_DOMAIN = `${createHash('sha256').update(state.authSecret).digest('hex').slice(0, 12)}.check.staging.blockly.test`
// Every server a run makes starts its create key with this, derived from staging's secret too:
// the next run purges what an earlier one left by it, and never a server anybody else made.
const CHECK_MARK = createHash('sha256').update(`staging-check:${state.authSecret}`).digest('hex')
const CHECK_KEY_PREFIX = `${CHECK_MARK.slice(0, 8)}-${CHECK_MARK.slice(8, 12)}-`
/** A create key for one of the check's servers: the mark, then a random UUID's version and the rest. */
const checkKey = () => `${CHECK_KEY_PREFIX}${randomUUID().slice(14)}`

const failures: string[] = []
const timings: string[] = []
const results: StepResult[] = []
const journeys: Journey[] = []
setInterval(() => {
  for (const journey of journeys) journey.progress.tick()
}, 1000).unref()

function check(held: boolean, complaint: string): void {
  if (!held) throw new Error(complaint)
}

/**
 * One account and its one server, taken through steps one after another while other journeys run
 * theirs. Each line it prints, each row of the summary and each failure carries its name.
 */
class Journey {
  readonly name: string
  readonly progress: Progress
  api: Api = async () => {
    throw new Error('no account yet')
  }
  owner = { email: '', password: '' }
  server = { id: '', slug: '' }
  /**
   * What Fly last said of the server's machines, for progress lines. It is read in the background,
   * at most every 15 seconds, so a wait being timed (a join) is never held up by flyctl.
   */
  #flySeen = { text: '', at: 0, reading: false }

  constructor(name: string) {
    this.name = name
    this.progress = new Progress({ write: (line) => this.say(line) })
    journeys.push(this)
  }

  say(line: string): void {
    say(`${this.name.padEnd(7)}${line}`)
  }

  async step(name: string, run: () => Promise<string | undefined>, limitSeconds = 900): Promise<void> {
    const started = Date.now()
    const row = `${this.name}: ${name}`
    this.progress.begin()
    try {
      const note = await Promise.race([
        run(),
        new Promise<never>((_, stop) =>
          setTimeout(() => stop(new Error(`gave up after ${limitSeconds}s`)), limitSeconds * 1000).unref(),
        ),
      ])
      this.progress.end()
      results.push({ name: row, ok: true, ms: Date.now() - started })
      this.say(`  ok   ${name}${note ? ` — ${note}` : ''}  (${seconds(Date.now() - started)})`)
    } catch (error) {
      this.progress.end()
      failures.push(row)
      results.push({ name: row, ok: false, ms: Date.now() - started })
      this.say(`  FAIL ${name} — ${(error as Error).message}  (${seconds(Date.now() - started)})`)
    }
  }

  timed(what: string, ms: number): string {
    timings.push(`${this.name}: ${what}: ${seconds(ms)}`)
    return seconds(ms)
  }

  view() {
    return this.api('servers.get', { serverId: this.server.id }, 'GET')
  }

  #readFly(): void {
    const seen = this.#flySeen
    if (this.server.id === '' || seen.reading || Date.now() - seen.at < 15_000) return
    seen.reading = true
    machinesOf(this.server.id)
      .then((machines) => {
        const states = machines.map((m) => m.state)
        seen.text = `Fly: ${states.length === 0 ? 'no machine' : states.join(', ')}`
      })
      .catch(() => undefined)
      .finally(() => {
        seen.at = Date.now()
        seen.reading = false
      })
  }

  /** What a progress line says of the server: its state, the operation on it, and Fly's machines. */
  // biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as waitFor reads it
  sawServer(v: any): void {
    const op = v.activeOperation
    const reason = v.status === 'stopped' && v.stopReason ? ` (${v.stopReason})` : ''
    const operation = op ? `, ${op.kind}: ${op.step ?? op.status}` : ''
    this.#readFly()
    const fly = this.#flySeen.text
    this.progress.saw(`server ${v.status}${reason}${operation}${fly ? ` | ${fly}` : ''}`)
  }

  // biome-ignore lint/suspicious/noExplicitAny: the app's own contracts, read loosely as in the smoke test
  async waitFor(want: (v: any) => boolean, what: string, limit = 600): Promise<any> {
    this.progress.waiting(what)
    const deadline = Date.now() + limit * 1000
    while (Date.now() < deadline) {
      const now = await this.view()
      if (want(now)) return now
      this.sawServer(now)
      await Bun.sleep(2000)
    }
    throw new Error(`never ${what} within ${limit}s`)
  }

  /** A wait on something other than the server's state (a join), with the server watched meanwhile. */
  async watching<T>(what: string, wait: Promise<T>): Promise<T> {
    this.progress.waiting(what)
    let over = false
    const watch = async () => {
      while (!over) {
        await this.view().then(
          (v) => this.sawServer(v),
          () => undefined,
        )
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

  settled(limit = 600) {
    return this.waitFor((v) => v.activeOperation === null, 'settled', limit)
  }

  address(): string {
    return `${this.server.slug}.${PLAY_DOMAIN}`
  }

  /** A player joining through the edge, timed, with the server watched meanwhile. */
  joins(what: string, player: string, limitMs: number): Promise<number> {
    return this.watching(what, join(EDGE, this.address(), player, limitMs))
  }

  async consoleSays(command: string): Promise<string> {
    return String((await this.api('console.run', { serverId: this.server.id, command })).output ?? '')
  }

  async seedOf(): Promise<string> {
    return (await this.consoleSays('seed')).match(/-?\d+/)?.[0] ?? ''
  }

  /** How long an operation of this kind last took, from its own record. */
  tookOf(kind: string): Promise<string> {
    return sql(
      `select round(extract(epoch from (finished_at - created_at))::numeric, 1) from server_operations where server_id = '${this.server.id}' and kind = '${kind}' and status = 'succeeded' order by created_at desc limit 1`,
    )
  }

  /**
   * Its account signed up and its server made and up, a plain survival one unless a template is
   * named; whether it got that far.
   */
  async begin(template?: string): Promise<boolean> {
    await this.step('signs up on staging and confirms through its mail catcher', async () => {
      const email = `check-${this.name}-${Date.now()}@${CHECK_DOMAIN}`
      const them = await people(WEB, 'http://127.0.0.1:18025').person(email)
      // Cubepals' own test account, so the check takes none of staging's free places.
      await sql(
        `update account_standing set test_account = true where user_id = (select id from users where email = '${email}')`,
      )
      this.owner = { email: them.email, password: them.password }
      this.api = them.api
      const { entitlements } = await this.api('account.overview', {}, 'GET')
      check(entitlements.plan === 'free', `plan is ${entitlements.plan}`)
      return email
    })
    if (this.owner.email === '') return false
    if (template !== undefined) await this.step('is offered on its plan', () => this.onPlanFor(template))
    await this.step('is made on Fly and comes up', async () => {
      const at = Date.now()
      const created = await this.api('servers.create', {
        idempotencyKey: checkKey(),
        name: 'Staging Check',
        partySize: '5',
        regionKey: 'eu',
        ...(template === undefined
          ? { playStyle: 'survival', loader: 'vanilla' }
          : { from: { kind: 'template', key: template } }),
      })
      this.server = { id: created.id, slug: created.slug }
      const up = await this.waitFor((v) => v.status === 'running', 'came up', 900)
      const took = this.timed(
        'first start (new app, volume and machine, image pulled, world made)',
        Date.now() - at,
      )
      await this.settled()
      // A new server that can't come up where it was placed is put on another runtime and comes up
      // there, slower; a player would have waited through the first, so it fails here.
      const fellBack = await sql(
        `select format('from %s to %s: %s', from_provider, provider, reason) from runtime_decisions where server_id = '${this.server.id}' and kind = 'fell_back' order by at desc limit 1`,
      )
      check(fellBack === '', `it never came up where it was placed, after ${took}, and fell back ${fellBack}`)
      const machines = await machinesOf(this.server.id)
      check(
        machines.some((m) => m.state === 'started'),
        `Fly shows ${machines.map((m) => m.state).join(', ')}`,
      )
      const volumes = (await volumesOf(this.server.id)).map((v) => `${v.size_gb} GB`).join(', ')
      return `${this.address()} (${this.server.id}), ${up.memoryTier} in ${took}; Fly: ${machines.length} machine, ${volumes}`
    })
    return this.server.id !== ''
  }

  /**
   * The template is on the create page, and its account on a plan that runs it: the one the page
   * names, through staging's database, when Free doesn't.
   */
  async onPlanFor(template: string): Promise<string> {
    const offered = (await this.api('servers.createOptions', {}, 'GET')).templates as {
      key: string
      fits: { allowed: boolean; plan?: string | null }
    }[]
    const fits = offered.find((t) => t.key === template)?.fits
    check(fits !== undefined, 'staging does not offer it')
    if (fits?.allowed) return 'on Free'
    check(typeof fits?.plan === 'string', 'no plan runs it')
    await sql(
      `update account_standing set plan = '${fits?.plan}' where user_id = (select id from users where email = '${this.owner.email}')`,
    )
    return `its account moved to ${fits?.plan}`
  }

  /** Whether the server runs on Fly, and not on the runtime a new server falls back to. */
  async onFly(): Promise<boolean> {
    return (await sql(`select provider from server_runtimes where server_id = '${this.server.id}'`)) === 'fly'
  }

  /** The end of a journey, unless the run keeps what it made. */
  async trash(): Promise<void> {
    if (KEEP) return
    await this.step('goes to the trash: its machine goes, its volume stays', async () => {
      await this.api('servers.delete', { serverId: this.server.id, confirmName: 'Staging Check' })
      await this.waitFor((v) => v.activeOperation === null && v.status === 'deleted', 'deleted', 300).catch(
        () => undefined,
      )
      if (!(await this.onFly())) return 'not on Fly, so Fly holds nothing of it'
      const machines = await machinesOf(this.server.id)
      return `Fly: ${machines.length} machines, ${(await volumesOf(this.server.id)).length} volume kept for the trash`
    })
  }
}

/** Each of these servers not purged yet, what it is, and the work open on it, oldest first. */
async function notPurged(ids: string[]): Promise<NotPurged[]> {
  return (await database.unsafe(
    `select s.id, s.status, o.kind, o.status as op, o.progress->>'step' as step, o.started_at as since
     from minecraft_servers s left join lateral (
       select kind, status, progress, started_at from server_operations
       where server_id = s.id and status in ('queued', 'running') order by created_at limit 1
     ) o on true
     where s.id in (${ids.map((id) => `'${id}'`).join(', ')}) and s.status <> 'purged'`,
  )) as NotPurged[]
}

interface NotPurged {
  id: string
  status: string
  kind: string | null
  op: string | null
  step: string | null
  since: Date | null
}

/** A server not purged, in a line: `14767445 (deleted), start running at starting since 02:50:41`. */
function waitingOn(server: NotPurged): string {
  const what = `${server.id.slice(0, 8)} (${server.status})`
  if (server.kind === null) return `${what}, nothing under way`
  const at = server.step === null ? '' : ` at ${server.step}`
  const since = server.since === null ? '' : ` since ${new Date(server.since).toISOString().slice(11, 19)}`
  return `${what}, ${server.kind} ${server.op}${at}${since}`
}

/**
 * Runs the purge sweep now, and waits until each of these servers is purged or `seconds` pass.
 * Returns the ones still not purged, saying what each waits on as it waits.
 */
async function purging(journey: Journey, ids: string[], seconds: number): Promise<NotPurged[]> {
  await sweep('purge-sweep')
  journey.progress.waiting('purged')
  const deadline = Date.now() + seconds * 1000
  for (let left = await notPurged(ids); ; left = await notPurged(ids)) {
    if (left.length === 0 || Date.now() >= deadline) return left
    journey.progress.saw(`${left.length} of ${ids.length} not purged: ${left.map(waitingOn).join('; ')}`)
    await Bun.sleep(5000)
  }
}

/** Runs the purge sweep now, and waits until each of these servers is purged. */
async function purged(journey: Journey, ids: string[]): Promise<void> {
  const left = await purging(journey, ids, 600)
  check(left.length === 0, `${left.length} of ${ids.length} not purged: ${left.map(waitingOn).join('; ')}`)
}

/** A server's Fly app, `bly-staging-` and its id's 32 hex digits, back to that id. */
function serverIdOf(app: string): string | undefined {
  const hex = /^bly-staging-([0-9a-f]{32})$/.exec(app)?.[1]
  return (
    hex && `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  )
}

/** Made, joined through the edge, asleep on its own, woken by a join. */
async function sleeps(j: Journey): Promise<void> {
  if (!(await j.begin())) return
  let sleptAs = ''

  await j.step('answers a player through the edge, at its own address', async () => {
    const took = await j.joins('a player answered', 'StagingCheck', MINUTE_MS)
    const said = await login(EDGE, j.address(), 'StagingCheck')
    check(said === 'wants an account', `the server said "${said}"`)
    return `${j.address()} answered in ${j.timed('join while running', took)}, and asks for an account`
  })

  await j.step(
    'goes to sleep on its own when nobody plays',
    async () => {
      // The control plane's own idle check, on this account's idle time rather than the plan's.
      // Whatever happens, the account goes back to its plan's after this step, so nothing later in
      // the journey is put to sleep under it.
      const account = `user_id = (select id from users where email = '${j.owner.email}')`
      await sql(
        `update account_standing set limit_overrides = limit_overrides || '{"idleShutdownAfterMinutes": ${SLEEP_AFTER_MINUTES}}' where ${account}`,
      )
      try {
        const at = Date.now()
        const asleep = await j.waitFor((v) => v.status === 'stopped', 'went to sleep', 1500)
        await j.settled()
        check(asleep.stopReason === 'idle', `it stopped for ${asleep.stopReason}`)
        // Asleep is suspended where the deployment suspends (FLY_SUSPEND), stopped where it doesn't.
        const machines = await machinesOf(j.server.id)
        const states = [...new Set(machines.map((m) => m.state))]
        check(
          states.length === 1 && (states[0] === 'suspended' || states[0] === 'stopped'),
          `Fly shows ${machines.map((m) => m.state).join(', ')}`,
        )
        sleptAs = states[0] ?? ''
        check((await keptVolumes(j.server.id)).length > 0, 'Fly kept no volume for it')
        return `after ${seconds(Date.now() - at)} of waiting, idle after ${SLEEP_AFTER_MINUTES} min on this account; its machine is ${states[0]}, its volume kept`
      } finally {
        await sql(
          `update account_standing set limit_overrides = limit_overrides - 'idleShutdownAfterMinutes' where ${account}`,
        )
      }
    },
    1600,
  )

  await j.step('wakes when a player joins', async () => {
    const took = await j.joins('a joining player answered', 'StagingWaker', 300_000)
    await j.waitFor((v) => v.status === 'running', 'woke', 300)
    await j.settled()
    const waited = j.timed('wake from sleep (machine started)', took)
    check(
      sleptAs !== 'suspended' || took <= SUSPENDED_WAKE_LIMIT_MS,
      `the player waited ${waited} to wake it from suspend, over ${seconds(SUSPENDED_WAKE_LIMIT_MS)}`,
    )
    return `the player waited ${waited}`
  })

  await j.trash()
}

/** Made, written into, rested in the archive store, woken from it by a join, the same world. */
async function rests(j: Journey): Promise<void> {
  if (!(await j.begin())) return
  const markOf = async () =>
    (await j.consoleSays('scoreboard players get check blockly_check')).match(/has (-?\d+)/)?.[1] ?? ''

  let world = { seed: '', mark: '' }
  await j.step('keeps what is written into its world', async () => {
    world.seed = await j.seedOf()
    check(world.seed !== '', 'the server would not say its seed')
    const mark = String(randomInt(1, 1_000_000))
    await j.consoleSays('scoreboard objectives add blockly_check dummy')
    await j.consoleSays(`scoreboard players set check blockly_check ${mark}`)
    await j.consoleSays('save-all flush')
    world = { ...world, mark: await markOf() }
    check(world.mark === mark, `the mark reads "${world.mark}"`)
    return `seed ${world.seed}, mark ${mark}`
  })

  await j.step(
    'rests in the archive store once nobody has played for weeks, and lets go of Fly',
    async () => {
      await j.api('servers.stop', { serverId: j.server.id, requestId: randomUUID() })
      await j.waitFor((v) => v.status === 'stopped', 'stopped', 300)
      await j.settled()
      // Two weeks without play, as far as the sweep can tell, then the sweep itself, rather than
      // waiting for its hour.
      await sql(
        `update minecraft_servers set last_active_at = now() - interval '15 days' where id = '${j.server.id}'`,
      )
      await sweep('store-sweep')
      const stored = await j.waitFor((v) => v.status === 'stored', 'rested', 1200)
      check(stored.status === 'stored', `it is ${stored.status}`)
      const machines = await machinesOf(j.server.id)
      const volumes = await keptVolumes(j.server.id)
      check(machines.length === 0, `Fly still has ${machines.map((m) => `${m.name} ${m.state}`).join(', ')}`)
      check(volumes.length === 0, `Fly still has ${volumes.map((v) => `${v.name} ${v.state}`).join(', ')}`)
      const key = await sql(
        `select archive_key from backups where server_id = '${j.server.id}' and trigger = 'stored' and status = 'ready' order by created_at desc limit 1`,
      )
      check(key !== '', 'no stored copy is recorded')
      const head = await bucket.send(new HeadObjectCommand({ Bucket: state.bucket.name, Key: key }))
      return `stored in ${j.timed('rest (snapshot, export to the bucket, release)', Number(await j.tookOf('store')) * 1000)}; no machine or volume left; the copy is ${((head.ContentLength ?? 0) / 2 ** 20).toFixed(1)} MB`
    },
  )

  await j.step('comes back from the archive when a player joins', async () => {
    const took = await j.joins('a joining player answered', 'StagingWaker', 900_000)
    await j.waitFor((v) => v.status === 'running', 'came back', 600)
    await j.settled()
    const restore = Number(await j.tookOf('unstore')) * 1000
    return `the player waited ${j.timed('wake from rest (new volume, copy downloaded and unpacked, boot)', took)}; the restore itself took ${seconds(restore)}`
  })

  await j.step('is the same world', async () => {
    const seed = await j.seedOf()
    const mark = await markOf()
    check(seed === world.seed, `the seed was ${world.seed} and is ${seed}`)
    check(mark === world.mark, `the mark was ${world.mark} and is ${mark}`)
    return `seed ${seed}, mark ${mark}`
  })

  await j.trash()
}

/** Made, its machine killed under it, back as the same world. */
async function crashes(j: Journey): Promise<void> {
  if (!(await j.begin())) return

  await j.step('comes back after its machine is killed under it', async () => {
    const seed = await j.seedOf()
    check(seed !== '', 'the server would not say its seed')
    const machine = (await machinesOf(j.server.id)).find((m) => m.state === 'started')
    check(machine !== undefined, 'no machine is running')
    await fly(['machine', 'kill', machine?.id ?? '', '-a', appOf(j.server.id)])
    const at = Date.now()
    // Fly restarts a machine whose process died (the restart policy is on-failure), so it's back
    // without Blockly doing anything; had Fly given up, Blockly would see it stopped and start it.
    await Bun.sleep(5000)
    const seen = await j.view()
    if (seen.status === 'stopped' || seen.status === 'crashed')
      await j.api('servers.start', { serverId: j.server.id, requestId: randomUUID() })
    await j.joins('a player answered', 'StagingCheck', 300_000)
    const took = Date.now() - at
    await j.waitFor((v) => v.status === 'running', 'running again', 300)
    check((await j.seedOf()) === seed, 'it came back as another world')
    return `answering players again ${j.timed('back after a crash (Fly restarts the machine)', took)} after the kill, the same world${seen.status === 'running' ? ', without Blockly having to start it' : `, started by Blockly after it saw ${seen.status}`}`
  })

  await j.trash()
}

/**
 * Cubepals' own templates: each one whose setup carries a datapack Cubepals writes, with the
 * datapack's folder, the name Minecraft lists it by, and the function its load tag runs, which
 * only that datapack answers.
 */
const OWN_TEMPLATES = TEMPLATES.flatMap(({ key, setup }) =>
  (setup.files ?? []).flatMap(({ path, content }) => {
    const pack = /\/datapacks\/([^/]+)\/data\/minecraft\/tags\/function\/load\.json$/.exec(path)?.[1]
    const load = pack && (JSON.parse(content) as { values: string[] }).values[0]
    return pack && load ? [{ key, pack, load }] : []
  }),
)

/**
 * One of Cubepals' own templates, made and booted cold as a player's first server of it is, its
 * own datapack answering on the console, then asleep and woken with nothing changed.
 */
async function ownTemplate(j: Journey, own: (typeof OWN_TEMPLATES)[number]): Promise<void> {
  if (!(await j.begin(own.key))) return
  const answers = async () => {
    const enabled = await j.consoleSays('datapack list enabled')
    check(enabled.includes(`file/${own.pack}`), `${own.pack} is not among its datapacks: "${enabled}"`)
    const said = await j.consoleSays(`function ${own.load}`)
    check(said.includes(own.load) && !/unknown/i.test(said), `function ${own.load} answered "${said}"`)
    return said
  }

  await j.step('its own datapack is loaded and answers', async () => `${own.pack}: ${await answers()}`)

  await j.step('goes to sleep and wakes with nothing changed', async () => {
    await j.api('servers.stop', { serverId: j.server.id, requestId: randomUUID() })
    await j.waitFor((v) => v.status === 'stopped', 'went to sleep', 300)
    await j.settled()
    const slept = (await j.onFly())
      ? `its machine ${[...new Set((await machinesOf(j.server.id)).map((m) => m.state))].join(', ')}`
      : 'not on Fly'
    const at = Date.now()
    await j.api('servers.start', { serverId: j.server.id, requestId: randomUUID() })
    await j.waitFor((v) => v.status === 'running', 'woke', 600)
    await j.settled()
    const took = j.timed('wake (nothing changed)', Date.now() - at)
    await answers()
    return `${slept} while asleep; woke in ${took}, its datapack answering again`
  })

  await j.step('a player is in the world within moments of logging in, awake and woken by the join', () =>
    ownGameJoins(j, EDGE, sql),
  )

  await j.trash()
}

const started = Date.now()
say(`staging check: ${WEB}, players at <server>.${PLAY_DOMAIN}`)

// A run that stops before its end leaves its servers, and their volumes, behind; staging's control
// plane runs a few minutes a night, too briefly for its own sweeps to catch them. Earlier runs'
// servers, known by the mark in their create key, go through the same purge as this run's own,
// and a server app no server holds goes too. A server still busy with work ahead of its purge
// (an operation a restart cut off, say) is no fault of this run: it is named, and left for the next.
const before = new Journey('before')
await before.step(
  'what earlier runs left is purged, and Fly holds no server app without a server',
  async () => {
    // Accounts earlier runs made before they were marked as Cubepals' own filled staging's free
    // places, and sign-up refused the next run's (2026-10-11).
    await sql(
      `update account_standing set test_account = true from users where users.id = account_standing.user_id
       and users.email like '%@${CHECK_DOMAIN}' and not account_standing.test_account`,
    )
    const left = (await database.unsafe(
      `select id from minecraft_servers where create_idempotency_key like '${CHECK_KEY_PREFIX}%' and status <> 'purged'`,
    )) as { id: string }[]
    const ids = left.map(({ id }) => id)
    let busy: NotPurged[] = []
    if (ids.length > 0) {
      await sql(
        `update minecraft_servers set status = 'deleted', deleted_at = coalesce(deleted_at, now()),
         purge_after = now() - interval '1 minute' where id in (${ids.map((id) => `'${id}'`).join(', ')})`,
      )
      const stuck = await purging(before, ids, 300)
      busy = stuck.filter(
        (server) => server.kind !== null && !['decommission', 'purge'].includes(server.kind),
      )
      const failed = stuck.filter((server) => !busy.includes(server))
      check(failed.length === 0, `not purged: ${failed.map(waitingOn).join('; ')}`)
    }
    const unheld: string[] = []
    for (const app of await serverApps()) {
      const id = serverIdOf(app)
      if (id === undefined) continue
      const status = await sql(`select status from minecraft_servers where id = '${id}'`)
      if (status !== '' && status !== 'purged') continue
      await fly(['apps', 'destroy', app, '--yes'])
      unheld.push(app)
    }
    const waiting =
      busy.length === 0 ? '' : `; left for the next run, still busy: ${busy.map(waitingOn).join('; ')}`
    return `${ids.length - busy.length} servers purged, ${unheld.length} apps without a server destroyed${waiting}`
  },
)

const sleep = new Journey('sleep')
const rest = new Journey('rest')
const crash = new Journey('crash')
const owns = OWN_TEMPLATES.map((own) => ({ own, j: new Journey(own.key) }))
say(
  `\n${3 + owns.length} servers at once: sleep (asleep and woken), rest (archived and back), crash (killed and back), and ${owns.map(({ own }) => own.key).join(', ')} (Cubepals' own templates, booted cold)`,
)
await Promise.all([
  sleeps(sleep),
  rests(rest),
  crashes(crash),
  ...owns.map(({ own, j }) => ownTemplate(j, own)),
])

const made = [sleep, rest, crash, ...owns.map(({ j }) => j)].filter((j) => j.server.id !== '')
if (KEEP)
  for (const j of made)
    say(`\nkept (${j.name}): ${j.owner.email} / ${j.owner.password}, server ${j.server.id}`)
// Staging's control plane is stopped between runs, so its own sweep would never empty this trash:
// each run would leave volumes behind. Their time in the trash is up, then the sweep runs now.
else if (made.length > 0) {
  const after = new Journey('after')
  await after.step('the trash is purged once its time is up, and Fly holds nothing of it', async () => {
    const ids = made.map((j) => j.server.id)
    await sql(
      `update minecraft_servers set purge_after = now() - interval '1 minute' where id in (${ids.map((id) => `'${id}'`).join(', ')})`,
    )
    await purged(after, ids)
    const apps = await serverApps()
    const left = ids.map(appOf).filter((app) => apps.includes(app))
    check(left.length === 0, `Fly still has ${left.join(', ')}`)
    return `${ids.length} servers purged by the sweep; their Fly apps, machines and volumes are gone`
  })
}

say(`\n${timings.map((line) => `  ${line}`).join('\n')}`)
say(`\n${summaryTable(results, Date.now() - started).join('\n')}`)
const summary = failures.length === 0 ? 'all good' : `${failures.length} failed: ${failures.join(', ')}`
say(`\n${summary} in ${seconds(Date.now() - started)}`)
process.exit(failures.length === 0 ? 0 : 1)
