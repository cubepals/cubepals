// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every wait a person sees on staging, step by step. It runs against whatever staging runs:
 *
 *   bun scripts/staging-waits.ts            one server made, taken through each wait, then trashed
 *   bun scripts/staging-waits.ts --keep     leaves the account and its server to look at
 *   bun scripts/staging-waits.ts --pack [name]
 *                                           a server from a pack instead: made, restarted, and moved to
 *                                           the pack's next version where there is one. With a name, the
 *                                           catalog's pack by that name, made on the version before its
 *                                           newest; without, the first pack Blockly offers by name
 *   bun scripts/staging-waits.ts --mods     a Fabric server instead: made, then two mods added, one by one
 *   bun scripts/staging-waits.ts --rest [--world-mb N]
 *                                           made, stopped, started again, then rested in the archive
 *                                           store and woken from it, with N MB more world on it
 *   bun scripts/staging-waits.ts --wake <template> [--wakes N]
 *                                           a server of that template made, then stopped and woken
 *                                           N times, each wake with Fly's events and every line the
 *                                           machine printed, by its seconds since the click
 *   … --as <email>:<password>               an account made before, for a staging full of sign-ups
 *
 * The free plan runs no pack, and no mods, so `--pack`, `--mods`, and the plain run before its mods,
 * put its account on Plus through staging's database, as staging.ts reaches it (a `fly proxy` to
 * the database on Fly, or STAGING_DATABASE_URL when STAGING_DATABASE=supabase); every run marks its account as Cubepals' own test account the same way.
 * `--rest` reaches it the same way: it moves the server's last play back past the Free plan's days
 * and runs the store sweep at once, as the staging check does, then checks with flyctl that a rested
 * server holds no machine or volume, and a woken one holds one of each. Its extra world is
 * incompressible bytes written onto the volume, which packs no smaller, as a world's region files
 * hardly do.
 *
 * Each wait is timed from the click to the server settled, and split by the step `servers.get`
 * reported, as the server's page shows it: a step's time is from when it was first seen to when
 * the next one was. It polls twice a second, so a step shorter than that can go unseen.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { HOUR_S } from '@blockly/contracts/durations'
import { MAIL_PORT } from '@blockly/contracts/local'
import { SQL } from 'bun'
import { runScheduledNow } from '../apps/control/src/infra/pg/jobs.ts'
import { type Api, people } from './lib/people.ts'
import { reachDatabase } from './lib/staging-database.ts'

const WEB = 'https://staging.cubepals.com'
const KEEP = process.argv.includes('--keep')
const PACK = process.argv.includes('--pack')
const MODS = process.argv.includes('--mods')
const PACK_NAME = PACK ? process.argv[process.argv.indexOf('--pack') + 1]?.replace(/^--.*/, '') || null : null
const REST = process.argv.includes('--rest')
const WAKE = process.argv.includes('--wake') ? (process.argv[process.argv.indexOf('--wake') + 1] ?? '') : null
const WAKES = Number(process.argv[process.argv.indexOf('--wakes') + 1] ?? 0) || 2
const WORLD_MB = Number(process.argv[process.argv.indexOf('--world-mb') + 1] ?? 0) || 0

const say = (line: string) => process.stdout.write(`${line}\n`)
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const mail = spawn('fly', ['proxy', `18025:${MAIL_PORT}`, '-a', 'bly-staging-mail'], { stdio: 'ignore' })
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

/** Staging's state, as the staging check reaches it (STAGING_STATE or local/staging/state.json). */
const state = JSON.parse(
  existsSync('local/staging/state.json')
    ? readFileSync('local/staging/state.json', 'utf8')
    : (process.env.STAGING_STATE ?? '{}'),
) as { databaseUrl?: string; databasePassword?: string; authSecret: string }
/** Staging's database as staging.ts reaches it, through a proxy when it is on Fly. */
const reached = await reachDatabase(state)
const database = () => new SQL(reached.url)
// Staging lets only its allowlist make accounts; the staging check's domain is on it, and private
// to its state (staging.ts derives the same one).
const ACCOUNT = process.argv.includes('--as') ? process.argv[process.argv.indexOf('--as') + 1] : undefined
const email =
  ACCOUNT?.split(':')[0] ??
  `waits-${Date.now()}@${createHash('sha256').update(state.authSecret).digest('hex').slice(0, 12)}.check.staging.blockly.test`
const reach = people(WEB, 'http://127.0.0.1:18025')
// An account made before, while staging takes no more sign-ups: `--as email:password`.
const signedIn = async (password: string) => {
  const cookie = reach.cookiesOf(await reach.auth('sign-in/email', { email, password }))
  if (cookie === '') throw new Error(`signing in as ${email} set no session`)
  return { api: reach.apiAs(() => cookie), password }
}
const { api, password }: { api: Api; password: string } =
  ACCOUNT === undefined ? await reach.person(email) : await signedIn(ACCOUNT.slice(email.length + 1))
say(`waits on ${WEB} as ${email}`)
// Cubepals' own test account, as the staging check's are, so a run takes no free place from people.
{
  const sql = database()
  await sql`update account_standing set test_account = true where user_id = (select id from users where email = ${email})`
  if (PACK || MODS)
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
    if (seen.step !== null && steps.at(-1)?.step !== seen.step) {
      steps.push({ step: seen.step, at: Date.now() })
      say(`    ${seen.step} at ${seconds(Date.now() - at)}`)
    }
    if (seen.done) break
    await Bun.sleep(500)
  }
  const end = Date.now()
  const split = steps.map((s, i) => `${s.step} ${seconds((steps[i + 1]?.at ?? end) - s.at)}`).join(', ')
  // A change that didn't start goes back, and its wait is no change's.
  const back = steps.some((s) => s.step.endsWith(':rolling_back')) ? ', went back' : ''
  const line = `${what}: ${seconds(end - at)} (${split})${back}`
  lines.push(line)
  say(`  ${line}`)
}

/**
 * Where a wake's time went inside the machine: Fly's events for its start and every line the
 * machine printed (the image's `[init]`, Cubepals' steps, the JVM's and Paper's), each with its
 * seconds since the click at `asked`. Fly keeps only the last hundred lines, fewer than a boot
 * prints, so the lines are followed from before the click (`follow`) and read once it is over.
 */
function follow(app: string) {
  const tail = spawn('fly', ['logs', '-a', app, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let printed = ''
  tail.stdout.on('data', (chunk: Buffer) => {
    printed += chunk.toString()
  })
  return (asked: number): string[] => {
    tail.kill()
    const at = (ms: number) => `+${((ms - asked) / 1000).toFixed(2).padStart(6)}s`
    const machines = JSON.parse(
      Bun.spawnSync(['fly', 'machines', 'list', '--json', '-a', app], { stdout: 'pipe' }).stdout.toString() ||
        '[]',
    ) as { events?: { type: string; status: string; source: string; timestamp: number }[] }[]
    const events = machines
      .flatMap((m) => m.events ?? [])
      .map((e) => ({ ms: e.timestamp, text: `fly: ${e.type} ${e.status} (${e.source})` }))
    // flyctl prints one indented object after another, not a list.
    const objects = printed.trim().replaceAll('\n}\n{', '\n},\n{')
    const logs = (JSON.parse(`[${objects}]`) as { timestamp: string; message: string }[])
      .map((l) => ({ ms: Date.parse(l.timestamp), text: l.message.trim().slice(0, 140) }))
      .filter((l) => !l.text.startsWith('instance refused connection'))
    return [...events, ...logs]
      .filter((l) => l.ms >= asked - 2000)
      .sort((a, b) => a.ms - b.ms)
      .map((l) => `${at(l.ms)} ${l.text}`)
  }
}

let server = { id: '', slug: '' }
const running = () => onServer((v: { status: string }) => v.status === 'running')
const view = () => api('servers.get', { serverId: server.id }, 'GET')

/** Each mod added on its own, by its exact name; neither of those it is given needs another to run. */
async function addMods(names: string[]) {
  for (const name of names) {
    const found = await api('mods.search', { serverId: server.id, text: name, offset: 0 }, 'GET')
    const hit = found.hits.find((h: { name: string }) => h.name === name)
    const add = [{ projectId: hit?.projectId }]
    const plan = hit && (await api('mods.plan', { serverId: server.id, add }, 'GET'))
    if (plan?.kind !== 'ok')
      say(`  ${name} not added: ${plan ? `its plan came back as ${plan.kind}` : 'not found'}`)
    else
      await timed(
        `mods: ${name} added${plan.loader === (await view()).loader ? '' : ` (onto ${plan.loader})`}`,
        () =>
          api('mods.change', { serverId: server.id, requestId: randomUUID(), add, expected: plan.expected }),
        running(),
      )
  }
}

if (PACK) {
  // The first pack Blockly offers by name that this plan runs; else the most played one found.
  type Offered = {
    name: string
    fits: { allowed: boolean }
    runsOnServers?: boolean
    gameVersion?: string | null
  }
  const fits = (p: Offered) => p.fits.allowed && p.runsOnServers !== false && p.gameVersion !== null
  const curated =
    PACK_NAME === null
      ? ((await api('servers.createOptions', {}, 'GET')).packs as (Offered & { key: string })[]).find(fits)
      : undefined
  const found =
    curated === undefined
      ? (
          (await api('servers.searchModpacks', { text: PACK_NAME ?? '' }, 'GET')) as (Offered & {
            projectId: string
          })[]
        ).find(fits)
      : undefined
  const pack = curated ?? found
  if (pack === undefined) throw new Error('this plan runs none of the packs offered or found')
  // A pack by name is made on the version before its newest on the same Minecraft, so it has one
  // to update to.
  const versions = found
    ? ((await api('servers.packVersions', { projectId: found.projectId }, 'GET')) as {
        versionId: string
        gameVersion: string
      }[])
    : []
  const older = versions.slice(1).find((v) => v.gameVersion === versions[0]?.gameVersion)
  const from = curated
    ? { kind: 'curated', key: curated.key }
    : { kind: 'modpack', projectId: found?.projectId, ...(older ? { versionId: older.versionId } : {}) }
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
  const update = (await api('mods.list', { serverId: server.id }, 'GET')).packUpdate as {
    versionId: string
    label: string
    release: string | null
  } | null
  if (update === null) say('  no newer version of the pack to update to')
  else
    await timed(
      `pack update (to ${update.label})`,
      async () =>
        api('mods.changePack', {
          serverId: server.id,
          requestId: randomUUID(),
          version: (await view()).version,
          to:
            update.release !== null
              ? { kind: 'curated', version: update.release }
              : { kind: 'catalog', versionId: update.versionId },
        }),
      running(),
      1800,
    )
} else if (MODS) {
  await timed(
    'create (fabric)',
    async () => {
      server = await api('servers.create', {
        idempotencyKey: randomUUID(),
        name: 'Waits',
        playStyle: 'survival',
        partySize: '5',
        regionKey: 'eu',
        loader: 'fabric',
      })
      say(`  server ${server.id}`)
    },
    running(),
  )
  await addMods(['Lithium', 'FerriteCore'])
} else if (WAKE !== null) {
  await timed(
    `create (${WAKE})`,
    async () => {
      server = await api('servers.create', {
        idempotencyKey: randomUUID(),
        name: 'Waits',
        from: { kind: 'template', key: WAKE },
        partySize: '5',
        regionKey: 'eu',
      })
      say(`  server ${server.id}`)
    },
    running(),
    1800,
  )
  const app = `bly-staging-${server.id.replaceAll('-', '')}`
  const power = (verb: string) => () =>
    api(`servers.${verb}`, { serverId: server.id, requestId: randomUUID() })
  for (let wake = 1; wake <= WAKES; wake++) {
    await timed(
      'stop',
      power('stop'),
      onServer((v: { status: string }) => v.status === 'stopped'),
    )
    const timeline = follow(app)
    const asked = Date.now()
    await timed(`wake ${wake} (stopped)`, power('start'), running())
    // The last lines take a moment to come through.
    await Bun.sleep(3000)
    for (const line of timeline(asked)) say(`    ${line}`)
  }
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
  await runScheduledNow(reached.nodeUrl, 'store-sweep')
  await timed(
    'rest',
    async () => undefined,
    onServer((v: { status: string }) => v.status === 'stored'),
    HOUR_S,
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
  // Made two releases behind the newest, and moved one forward: the newest can lack a Paper build,
  // and moving off Paper as well is another change.
  const releases = (await api('servers.createOptions', {}, 'GET')).gameVersions as { value: string }[]
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
        gameVersion: releases[2]?.value,
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
  const newest = releases[1]?.value
  await timed(
    `version (to ${newest})`,
    async () => {
      const { loader } = await view()
      const planned = await api(
        'servers.planVersion',
        { serverId: server.id, gameVersion: newest, loader },
        'GET',
      )
      await api('servers.changeVersion', {
        ...(await change()),
        gameVersion: newest,
        loader,
        expected: planned.expected ?? [],
      })
    },
    running(),
  )
  await timed('world: fresh start', async () => api('worlds.startOver', await change()), running())
  // Mods are Plus's: the account moves up for them, through staging's database.
  const sql = database()
  await sql`update account_standing set plan = 'plus' where user_id = (select id from users where email = ${email})`
  await sql.close()
  // The first mod moves plain Minecraft to Fabric; the second is a mod change alone.
  await addMods(['Lithium', 'FerriteCore'])
}

if (KEEP) say(`\nkept: ${email} / ${password}, server ${server.id}`)
else await api('servers.delete', { serverId: server.id, confirmName: 'Waits' })
say(`\n${lines.join('\n')}`)
process.exit(0)
