// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every wait a person sees on staging, step by step. It runs against whatever staging runs:
 *
 *   bun scripts/staging-waits.ts            one server made, taken through each wait, then trashed
 *   bun scripts/staging-waits.ts --keep     leaves the account and its server to look at
 *   bun scripts/staging-waits.ts --pack     a server from a pack Blockly offers instead: made, restarted
 *   bun scripts/staging-waits.ts --rest [--world-mb N]
 *                                           made, stopped, started again, then rested in the archive
 *                                           store and woken from it, with N MB more world on it
 *
 * The free plan runs no pack, so `--pack` puts its account on Plus through staging's database, as
 * the staging check reaches it (STAGING_STATE or local/staging/state.json). `--rest` reaches it the
 * same way: it moves the server's last play back past the Free plan's days and runs the store sweep
 * at once, as the staging check does, then checks with flyctl that a rested server holds no
 * machine or volume, and a woken one holds one of each. Its extra world is incompressible bytes
 * written onto the volume, which packs no smaller, as a world's region files hardly do.
 *
 * Each wait is timed from the click to the server settled, and split by the step `servers.get`
 * reported, as the server's page shows it: a step's time is from when it was first seen to when
 * the next one was. It polls twice a second, so a step shorter than that can go unseen.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { SQL } from 'bun'
import { type Api, people } from './lib/people.ts'

const WEB = 'https://staging.cubepals.com'
const KEEP = process.argv.includes('--keep')
const PACK = process.argv.includes('--pack')
const REST = process.argv.includes('--rest')
const WORLD_MB = Number(process.argv[process.argv.indexOf('--world-mb') + 1] ?? 0) || 0

const say = (line: string) => process.stdout.write(`${line}\n`)
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const mail = spawn('fly', ['proxy', '18025:8025', '-a', 'bly-staging-mail'], { stdio: 'ignore' })
process.on('exit', () => mail.kill())
for (let i = 0; i < 30; i++) {
  if (
    await fetch('http://127.0.0.1:18025/api/v1/info').then(
      (r) => r.ok,
      () => false,
    )
  )
    break
  await Bun.sleep(1000)
}

const email = `waits-${Date.now()}@staging.blockly.test`
const { api, password }: { api: Api; password: string } = await people(WEB, 'http://127.0.0.1:18025').person(
  email,
)
say(`waits on ${WEB} as ${email}`)
/** Staging's database, Supabase's session pooler, as the staging check reaches it. */
function database(): SQL {
  const state = JSON.parse(
    existsSync('local/staging/state.json')
      ? readFileSync('local/staging/state.json', 'utf8')
      : (process.env.STAGING_STATE ?? '{}'),
  ) as { databaseUrl: string }
  return new SQL(state.databaseUrl)
}
if (PACK) {
  const sql = database()
  await sql`update account_standing set plan = 'plus' where user_id = (select id from users where email = ${email})`
  await sql.close()
}
const lines: string[] = []

/** Where a wait has got to: the step the page shows, and whether it is over. */
type Seen = { step: string | null; done: boolean }

/** A server's wait as its page follows it: the operation on it, until none is and it is `until`. */
// biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as in the staging check
const onServer = (until: (view: any) => boolean) => {
  let seenOperation = false
  return async (): Promise<Seen> => {
    const view = await api('servers.get', { serverId: server.id }, 'GET')
    const op = view.activeOperation
    if (op?.status === 'failed') throw new Error(String(op.error))
    if (op !== null) seenOperation = true
    return {
      step: op === null ? null : `${op.kind}:${op.step ?? op.status}`,
      done: op === null && seenOperation && until(view),
    }
  }
}

/**
 * Asks for something, then watches until it is over. What it prints is the whole wait and each
 * step's share of it.
 */
async function timed(what: string, ask: () => Promise<unknown>, watch: () => Promise<Seen>, limit = 900) {
  const at = Date.now()
  await ask()
  const steps: { step: string; at: number }[] = []
  for (;;) {
    if (Date.now() > at + limit * 1000) throw new Error(`${what}: not over within ${limit}s`)
    const seen = await watch()
    if (seen.step !== null && steps.at(-1)?.step !== seen.step)
      steps.push({ step: seen.step, at: Date.now() })
    if (seen.done) break
    await Bun.sleep(500)
  }
  const end = Date.now()
  const split = steps.map((s, i) => `${s.step} ${seconds((steps[i + 1]?.at ?? end) - s.at)}`).join(', ')
  const line = `${what}: ${seconds(end - at)} (${split})`
  lines.push(line)
  say(`  ${line}`)
}

let server = { id: '', slug: '' }
const running = () => onServer((v: { status: string }) => v.status === 'running')
const view = () => api('servers.get', { serverId: server.id }, 'GET')

if (PACK) {
  // The first pack Blockly offers by name that this plan runs; else the most played one found.
  type Offered = {
    name: string
    fits: { allowed: boolean }
    runsOnServers?: boolean
    gameVersion?: string | null
  }
  const fits = (p: Offered) => p.fits.allowed && p.runsOnServers !== false && p.gameVersion !== null
  const curated = (
    (await api('servers.createOptions', {}, 'GET')).packs as (Offered & { key: string })[]
  ).find(fits)
  const found =
    curated === undefined
      ? (
          (await api('servers.searchModpacks', { text: '' }, 'GET')) as (Offered & { projectId: string })[]
        ).find(fits)
      : undefined
  const pack = curated ?? found
  if (pack === undefined) throw new Error('this plan runs none of the packs offered or found')
  const from = curated
    ? { kind: 'curated', key: curated.key }
    : { kind: 'modpack', projectId: found?.projectId }
  await timed(
    `create (pack ${pack.name})`,
    async () => {
      server = await api('servers.create', {
        idempotencyKey: randomUUID(),
        name: 'Waits',
        from,
        partySize: '5',
        regionKey: 'eu',
      })
      say(`  server ${server.id}`)
    },
    running(),
    1800,
  )
  await timed(
    'restart (pack)',
    () => api('servers.restart', { serverId: server.id, requestId: randomUUID() }),
    running(),
  )
} else if (REST) {
  const sql = database()
  await timed(
    'create (vanilla)',
    async () => {
      server = await api('servers.create', {
        idempotencyKey: randomUUID(),
        name: 'Waits',
        playStyle: 'survival',
        partySize: '5',
        regionKey: 'eu',
        loader: 'vanilla',
      })
      say(`  server ${server.id}`)
    },
    running(),
  )
  const power = (verb: string) => () =>
    api(`servers.${verb}`, { serverId: server.id, requestId: randomUUID() })
  const app = `bly-staging-${server.id.replaceAll('-', '')}`
  const listed = (what: 'machines' | 'volumes') =>
    (JSON.parse(
      Bun.spawnSync(['fly', what, 'list', '-a', app, '--json'], { stdout: 'pipe' }).stdout.toString() || '[]',
    ) ?? []) as { id: string; state: string }[]
  const held = () => {
    const machines = listed('machines')
    const volumes = listed('volumes').filter((v) => v.state !== 'destroyed' && v.state !== 'pending_destroy')
    return `${machines.length} machine(s) ${machines.map((m) => m.state).join(',')}, ${volumes.length} volume(s)`
  }
  if (WORLD_MB > 0) {
    const machine = listed('machines').find((m) => m.state === 'started')
    const wrote = Bun.spawnSync(
      [
        'fly',
        'machine',
        'exec',
        machine?.id ?? '',
        `sh -c 'head -c ${WORLD_MB}M /dev/urandom > /data/world/blockly-waits.bin && du -sm /data'`,
        '-a',
        app,
        '--timeout',
        '600',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    say(
      `  world grown by ${WORLD_MB} MB: ${wrote.stdout.toString().trim() || wrote.stderr.toString().trim()}`,
    )
  }
  await timed(
    'stop',
    power('stop'),
    onServer((v: { status: string }) => v.status === 'stopped'),
  )
  await timed('start (stopped)', power('start'), running())
  await timed(
    'stop',
    power('stop'),
    onServer((v: { status: string }) => v.status === 'stopped'),
  )
  // Two weeks without play, as far as the sweep can tell, and the sweep now rather than on its hour.
  await sql`update minecraft_servers set last_active_at = now() - interval '15 days' where id = ${server.id}`
  await sql`insert into pgboss.job (name, data, policy, retry_limit) values ('store-sweep', '{}', 'singleton', 0)`
  await timed(
    'rest',
    async () => undefined,
    onServer((v: { status: string }) => v.status === 'stored'),
    3600,
  )
  const [copy] =
    await sql`select size_bytes from backups where server_id = ${server.id} and trigger = 'stored' and status = 'ready' order by created_at desc limit 1`
  say(`  rested: the copy is ${((copy?.size_bytes ?? 0) / 2 ** 20).toFixed(1)} MB; Fly holds ${held()}`)
  lines.push(`rested: copy ${((copy?.size_bytes ?? 0) / 2 ** 20).toFixed(1)} MB; Fly holds ${held()}`)
  await timed('wake (stored)', power('start'), running(), 1800)
  say(`  woken: Fly holds ${held()}`)
  lines.push(`woken: Fly holds ${held()}`)
  const ops =
    await sql`select kind, round(extract(epoch from (finished_at - created_at))::numeric, 1) as took from server_operations where server_id = ${server.id} and status = 'succeeded' order by created_at`
  lines.push(
    `operations: ${ops.map((o: { kind: string; took: string }) => `${o.kind} ${o.took}s`).join(', ')}`,
  )
} else {
  await timed(
    'create (vanilla)',
    async () => {
      server = await api('servers.create', {
        idempotencyKey: randomUUID(),
        name: 'Waits',
        playStyle: 'survival',
        partySize: '5',
        regionKey: 'eu',
        loader: 'vanilla',
      })
      say(`  server ${server.id}`)
    },
    running(),
  )
  await timed(
    'restart',
    () => api('servers.restart', { serverId: server.id, requestId: randomUUID() }),
    running(),
  )

  const change = async () => ({
    serverId: server.id,
    requestId: randomUUID(),
    version: (await view()).version,
  })
  await timed(
    'settings: difficulty',
    async () => {
      const now = await view()
      const { onlineMode: _, ...settings } = now.settings
      await api('servers.changeSettings', {
        ...(await change()),
        settings: { ...settings, difficulty: settings.difficulty === 'hard' ? 'easy' : 'hard' },
      })
    },
    running(),
  )
  await timed(
    'settings: message of the day',
    async () => {
      const { onlineMode: _, ...settings } = (await view()).settings
      await api('servers.changeSettings', {
        ...(await change()),
        settings: { ...settings, motd: `Waits ${Date.now()}` },
      })
    },
    running(),
  )
  await timed(
    'online authentication off',
    async () => api('servers.changeAuthentication', { ...(await change()), onlineMode: false }),
    running(),
  )
  // A backup is no phase of the server's, so its page follows it through the backups list.
  let backups = 0
  await timed(
    'backup',
    async () => {
      backups = (await api('backups.list', { serverId: server.id }, 'GET')).backups.length
      await api('backups.create', { serverId: server.id, requestId: randomUUID() })
    },
    async () => {
      const listed = await api('backups.list', { serverId: server.id }, 'GET')
      const newest = listed.backups[0]
      if (listed.backups.length > backups && newest?.status === 'failed')
        throw new Error(String(newest.error))
      return {
        step: listed.inProgress ? 'backup:saving' : null,
        done: !listed.inProgress && listed.backups.length > backups,
      }
    },
  )
}

if (KEEP) say(`\nkept: ${email} / ${password}, server ${server.id}`)
else await api('servers.delete', { serverId: server.id, confirmName: 'Waits' })
say(`\n${lines.join('\n')}`)
process.exit(0)
