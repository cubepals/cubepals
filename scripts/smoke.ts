// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A smoke test over the running dev stack (`docker compose up -d && bun run dev`): one account
 * and one server, taken through what a person actually does with it — created, looked at in game,
 * changed, backed up, woken from sleep by a join, crashed, stopped at an admin's session cap, and
 * deleted. Every step asserts, and the run ends non-zero if any of them didn't hold.
 *
 * It uses the same API the pages call, the real containers, the real Minecraft protocol and the
 * real schedules, so a green run says the product works here, not that its units do.
 *
 * Run: bun run smoke            leaves nothing behind
 *      bun run smoke --keep     keeps the account and its servers to poke at
 *      bun run smoke --quick    skips the steps that wait for a minute-by-minute schedule
 */
import { randomUUID } from 'node:crypto'
import { type Edge, join, login } from './lib/minecraft.ts'
import { type Api, type Person, people } from './lib/people.ts'

const WEB = process.env.SMOKE_WEB ?? 'http://localhost:3000'
const MAILPIT = process.env.SMOKE_MAILPIT ?? 'http://localhost:8025'
// The dev stack's database; a second stack beside it (another worktree) names its own.
const DATABASE = process.env.SMOKE_DATABASE ?? 'blockly'
const EDGE: Edge = { host: '127.0.0.1', port: 25565 }
// A version the real Modrinth catalogue knows, so the plugin step has something to install.
const GAME_VERSION = process.env.SMOKE_VERSION ?? '1.21.8'
const KEEP = process.argv.includes('--keep')
const QUICK = process.argv.includes('--quick')

const say = (line: string) => process.stdout.write(`${line}\n`)
const ms = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`

// ─── Steps ───────────────────────────────────────────────────────────────────────────────────

const failures: string[] = []
let skipped = 0

/** A step that hangs is a failure like any other, so each one runs against a clock. */
const within = <T>(work: Promise<T>, seconds: number): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, stop) =>
      setTimeout(() => stop(new Error(`gave up after ${seconds}s`)), seconds * 1000).unref(),
    ),
  ])

async function step(name: string, run: () => Promise<string | undefined>, seconds = 600): Promise<void> {
  const started = Date.now()
  try {
    const note = await within(run(), seconds)
    say(`  ok   ${name}${note ? ` — ${note}` : ''}  (${ms(started)})`)
  } catch (error) {
    failures.push(name)
    say(`  FAIL ${name} — ${(error as Error).message}  (${ms(started)})`)
  }
}
const skip = (name: string, why: string) => {
  skipped++
  say(`  --   ${name} — ${why}`)
}
function check(held: boolean, complaint: string): void {
  if (!held) throw new Error(complaint)
}

// ─── The stack ───────────────────────────────────────────────────────────────────────────────

/** Runs a command and hands back its output; the shell is never involved. */
function run(command: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
  const out = `${result.stdout.toString()}${result.stderr.toString()}`.trim()
  return { ok: result.exitCode === 0, out }
}
/** One statement against the dev database, through the compose service, so nothing is installed. */
function psql(statement: string): string {
  const result = run([
    'docker',
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'blockly',
    '-d',
    DATABASE,
    '-t',
    '-A',
    '-c',
    statement,
  ])
  if (!result.ok) throw new Error(`database: ${result.out.split('\n').at(-1)}`)
  return result.out
}
const containerOf = (serverId: string) => {
  const { out } = run(['docker', 'ps', '-aq', '--filter', `label=blockly.server=${serverId}`])
  return out.split('\n')[0] ?? ''
}

// ─── The people ──────────────────────────────────────────────────────────────────────────────

const { person } = people(WEB, MAILPIT)

/**
 * An admin, for the steps that need one. A person like any other, made an admin the way the first
 * one ever was: a row saying so. Everything they then do goes through the admin API.
 */
async function admin(): Promise<Person> {
  const them = await person(`smoke-admin-${Date.now()}@example.test`)
  const id = psql(`select id from users where email = '${them.email}'`).trim()
  check(id !== '', 'the admin account was never written')
  psql(`insert into platform_admins (user_id, granted_by) values ('${id}', 'smoke')`)
  return them
}

/** Everything below runs as the person who owns the server, until an admin is needed. */
let owner: Person
const api: Api = (path, input, method) => owner.api(path, input, method)

const view = (serverId: string) => api('servers.get', { serverId }, 'GET')
/**
 * Waits for the server to look a certain way, giving up rather than hanging forever. `who` is
 * whose eyes to look through, for the steps that make a server of their own.
 */
async function waitFor(
  serverId: string,
  // biome-ignore lint/suspicious/noExplicitAny: read loosely on purpose, see Api above
  want: (v: any) => boolean,
  what: string,
  seconds = 300,
  who?: Person,
) {
  const look = who === undefined ? view : (id: string) => who.api('servers.get', { serverId: id }, 'GET')
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const now = await look(serverId)
    if (want(now)) return now
    await Bun.sleep(2000)
  }
  throw new Error(`never ${what} within ${seconds}s`)
}
const settled = (serverId: string, seconds = 300) =>
  waitFor(serverId, (v) => v.activeOperation === null, 'settled', seconds)

/** Waits for something to be there rather than for a server to look a certain way. */
async function until<T>(look: () => Promise<T | undefined>, what: string, seconds = 180): Promise<T> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const found = await look()
    if (found !== undefined) return found
    await Bun.sleep(2000)
  }
  throw new Error(`never saw ${what} within ${seconds}s`)
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

const started = Date.now()
say(`smoke: ${WEB}${QUICK ? ' (quick)' : ''}`)

// Nothing below works without the stack, so this is a hard stop rather than a failed step.
for (const [what, url] of [
  ['web app', `${WEB}/sign-in`],
  ['mail', `${MAILPIT}/api/v1/info`],
] as const) {
  const reachable = await fetch(url).then(
    (r) => r.ok,
    () => false,
  )
  if (!reachable) {
    say(`  the ${what} isn't answering at ${url} — run: docker compose up -d && bun run dev`)
    process.exit(2)
  }
}
if (!run(['docker', 'info']).ok) {
  say('  Docker is not running, and the servers need it')
  process.exit(2)
}

say('\nthe account')
await step('signs up and confirms by email', async () => {
  owner = await person(`smoke-${Date.now()}@example.test`)
  const me = await api('account.me', {}, 'GET')
  check(me.email === owner.email, `signed in as ${me.email}`)
  return owner.email
})
if (owner === undefined) {
  say('\nnothing to test without an account')
  process.exit(1)
}

await step('starts on the free plan: plain Minecraft, 20 hours', async () => {
  const { entitlements } = await api('account.overview', {}, 'GET')
  check(entitlements.plan === 'free', `plan is ${entitlements.plan}`)
  // Play is counted in hours on the one size free sells.
  check(entitlements.includedUnits === 20, `included play is ${entitlements.includedUnits}`)
  check(entitlements.mayBuyMore === false, 'free can buy more play')
  check(entitlements.playerIdleKickMinutes === 15, 'the AFK kick is not 15 minutes')
  // The month's hours bound the cost; no plan stops a run partway any more.
  check(entitlements.maxSessionMinutes === null, `a run is capped at ${entitlements.maxSessionMinutes} min`)
  check(entitlements.allowedMemoryTiers.join() === '3g', 'sizes are not just 3 GB')
  check(entitlements.allowedLoaders.join() === 'vanilla,paper', 'free runs more than Vanilla and Paper')
  check(entitlements.mayUseMods === false, 'free runs mods')
  return `${entitlements.includedUnits} h, ${entitlements.allowedLoaders.join(' and ')}`
})

await step('is told what its plan does not run, before anything boots', async () => {
  // Free is plain Minecraft for a small group. A party too big for 3 GB and a modded server type
  // are both refused before anything is created, in the words the create flow shows.
  const refused = (loader: string, partySize: string) =>
    api('servers.create', {
      idempotencyKey: randomUUID(),
      name: 'Not on free',
      playStyle: 'survival',
      partySize,
      gameVersion: GAME_VERSION,
      loader,
    }).then(
      () => '',
      (error: Error) => error.message,
    )
  const big = await refused('vanilla', '20')
  check(/plan|Plus/.test(big), `the big party's refusal read "${big}"`)
  const fabric = await refused('fabric', '5')
  check(/comes with Plus/.test(fabric), `Fabric's refusal read "${fabric}"`)
  return `${big} / ${fabric}`
})

say('\nthe server')
let server: { id: string; slug: string } = { id: '', slug: '' }
await step('is created and comes up', async () => {
  const created = await api('servers.create', {
    idempotencyKey: randomUUID(),
    name: 'Smoke Test',
    playStyle: 'survival',
    partySize: '5',
    gameVersion: GAME_VERSION,
    loader: 'vanilla',
  })
  server = { id: created.id, slug: created.slug }
  const up = await waitFor(created.id, (v) => v.status === 'running', 'came up', 420)
  await settled(created.id)
  return `${up.joinAddress} on ${up.memoryTier}`
})
if (server.id === '') {
  say('\nnothing to test without a server')
  process.exit(1)
}

await step('runs under the limits its plan sets', async () => {
  const container = containerOf(server.id)
  check(container !== '', 'no container for the server')
  const { ok, out } = run(['docker', 'exec', container, 'cat', '/data/server.properties'])
  check(ok, `couldn't read server.properties: ${out}`)
  const properties = new Map(
    out.split('\n').map((line) => [line.split('=')[0]?.trim() ?? '', line.split('=')[1]?.trim() ?? '']),
  )
  for (const [key, want] of [
    ['player-idle-timeout', '15'],
    ['max-world-size', '2500'],
    ['max-players', '5'],
    ['view-distance', '8'],
    ['simulation-distance', '6'],
  ] as const) {
    check(properties.get(key) === want, `${key} is ${properties.get(key)}, not ${want}`)
  }
  return 'AFK kick, world border and caps written'
})

await step(
  'answers a player who joins',
  async () => {
    const took = await join(EDGE, `${server.slug}.play.localhost`, 'SmokeTester', 60_000)
    return `answered in ${(took / 1000).toFixed(1)}s`
  },
  90,
)

await step('takes a console command', async () => {
  const { output } = await api('console.run', { serverId: server.id, command: 'list' })
  check(/players online/.test(output), `console said "${output}"`)
  return String(output).trim()
})

await step('applies a settings change to the world', async () => {
  const before = await view(server.id)
  await api('servers.changeSettings', {
    serverId: server.id,
    requestId: randomUUID(),
    version: before.version,
    settings: { ...before.settings, difficulty: 'hard', motd: 'Smoke test' },
  })
  await settled(server.id, 420)
  await waitFor(server.id, (v) => v.status === 'running', 'came back up', 420)
  await settled(server.id, 420)
  const { output } = await api('console.run', { serverId: server.id, command: 'difficulty' })
  check(/hard/i.test(output), `the server says "${output}"`)
  return String(output).trim()
})

await step('keeps a backup of the world', async () => {
  const now = await view(server.id)
  await api('backups.create', { serverId: server.id, requestId: randomUUID(), version: now.version })
  await settled(server.id, 420)
  const { backups } = await api('backups.list', { serverId: server.id }, 'GET')
  const ready = backups.filter((b: { status: string }) => b.status === 'ready')
  check(ready.length > 0, 'no backup came out ready')
  return `${ready.length} ready`
})

say('\nmods, archives and the directory')
let boss: Person | null = null
await step('finds an admin to lean on', async () => {
  boss = await admin()
  const { accounts } = await boss.api('admin.accounts', { search: owner.email, offset: 0 }, 'GET')
  check(accounts.length > 0, 'the admin could not find the owner')
  return boss.email
})

await step(
  'archives a backup, downloads it, and restores from it',
  async () => {
    // Every plan downloads its world: this runs on Free, which makes one download a day.
    const now = await view(server.id)
    const { backups } = await api('backups.list', { serverId: server.id }, 'GET')
    const snapshot = backups.find((b: { status: string }) => b.status === 'ready')
    check(snapshot !== undefined, 'there is no snapshot to archive')
    await api('backups.archive', {
      serverId: server.id,
      requestId: randomUUID(),
      version: now.version,
      backupId: snapshot.id,
    })
    await settled(server.id, 600)
    const archived = await until(async () => {
      const list = await api('backups.list', { serverId: server.id }, 'GET')
      return list.backups.find(
        (b: { tier: string; status: string }) => b.tier === 'archive' && b.status === 'ready',
      )
    }, 'the archive came out ready')

    // The link the page hands the owner has to answer with the tarball itself.
    const { url } = await api('backups.download', { serverId: server.id, backupId: archived.id })
    const head = await fetch(url, { headers: { range: 'bytes=0-1023' } })
    check(head.ok, `the download answered ${head.status}`)
    const bytes = (await head.arrayBuffer()).byteLength
    check(bytes > 0, 'the download was empty')

    // And restoring from it brings the world back, which is the only reason to keep one.
    const before = await view(server.id)
    await api('backups.restore', {
      serverId: server.id,
      requestId: randomUUID(),
      version: before.version,
      backupId: archived.id,
      withConfiguration: false,
    })
    await settled(server.id, 900)
    await waitFor(server.id, (v) => v.status === 'running' || v.status === 'stopped', 'restored', 900)
    await settled(server.id, 900)
    return `${(archived.sizeBytes / 1_000_000).toFixed(0)} MB archived, downloaded and restored`
  },
  1800,
)

await step(
  'moves to Paper and installs a plugin from the catalogue',
  async () => {
    const before = await view(server.id)
    const planned = await api(
      'servers.planVersion',
      { serverId: server.id, gameVersion: GAME_VERSION, loader: 'paper' },
      'GET',
    )
    await api('servers.changeVersion', {
      serverId: server.id,
      requestId: randomUUID(),
      version: before.version,
      gameVersion: GAME_VERSION,
      loader: 'paper',
      expected: planned.expected ?? [],
    })
    await settled(server.id, 600)
    await waitFor(server.id, (v) => v.loader === 'paper', 'became a Paper server', 600)

    const found = await api('mods.search', { serverId: server.id, text: 'spark', offset: 0 }, 'GET')
    const hit = found.hits.find((h: { runsOnServers: boolean }) => h.runsOnServers) ?? found.hits[0]
    check(hit !== undefined, 'the catalogue answered with nothing to install')
    const add = [{ projectId: hit.projectId }]
    const plan = await api('mods.plan', { serverId: server.id, add }, 'GET')
    check(plan.kind === 'ok', `the plan came back as ${plan.kind}`)
    // Paper is plain Minecraft on Free; a plugin is what makes it Plus's. Refused in words, with
    // nothing changed, and then the account moves up for the rest of the run.
    const refused = await api('mods.change', {
      serverId: server.id,
      requestId: randomUUID(),
      add,
      expected: plan.expected,
    }).then(
      () => '',
      (error: Error) => error.message,
    )
    check(/come with Plus/.test(refused), `free added a plugin: ${refused || 'no refusal'}`)
    check(boss !== null, 'there is no admin to change the plan')
    await boss.api('admin.setPlan', {
      userId: psql(`select id from users where email = '${owner.email}'`).trim(),
      plan: 'plus',
    })
    await api('mods.change', { serverId: server.id, requestId: randomUUID(), add, expected: plan.expected })
    await settled(server.id, 600)
    await waitFor(server.id, (v) => v.status === 'running', 'came back up with the plugin', 600)
    await settled(server.id, 600)

    const installed = await api('mods.list', { serverId: server.id }, 'GET')
    check(installed.mods.length > 0, 'the server lists no plugins')
    // What the page says is only worth as much as what is on the disk the server reads.
    const { out } = run(['docker', 'exec', containerOf(server.id), 'sh', '-c', 'ls /data/plugins'])
    check(/\.jar/.test(out), `the plugins folder holds ${out || 'nothing'}`)
    return `${installed.mods.map((m: { name: string }) => m.name).join(', ')} on disk`
  },
  900,
)

await step(
  'is published, found, reported, and taken down by an admin',
  async () => {
    check(boss !== null, 'there is no admin to moderate')
    await api('servers.saveIdentity', {
      serverId: server.id,
      name: 'Smoke Test World',
      description: 'A world the smoke run publishes, reports and has taken down again.',
      tags: ['survival'],
    })
    // Trust is the platform's, and it outlives a run: whatever an earlier run vouched for is
    // taken back first, so this one starts where a new plugin really starts.
    const plugins = await api('mods.list', { serverId: server.id }, 'GET')
    for (const mod of plugins.mods) {
      await boss
        .api('admin.untrust', {
          catalog: mod.catalog ?? 'modrinth',
          projectId: mod.projectId ?? mod.id,
        })
        .catch(() => undefined)
    }
    await api('listings.setPublic', { serverId: server.id, public: true })
    const held = await api('listings.own', { serverId: server.id }, 'GET')
    check(
      held.visible === false && held.reasons.some((r: { code: string }) => r.code === 'untrusted_mods'),
      `a listing with an unknown plugin should wait for the admins, not read ${JSON.stringify(held.reasons)}`,
    )
    // An admin vouches for the plugin, which is the only way a modded server reaches the directory.
    const installed = await api('mods.list', { serverId: server.id }, 'GET')
    for (const mod of installed.mods) {
      await boss.api('admin.trust', { projectId: mod.projectId ?? mod.id, note: 'Smoke run.' })
    }
    const listed = await until(
      async () => {
        const page = await api('listings.browse', { search: 'Smoke Test World', tag: null, offset: 0 }, 'GET')
        return page.listings.find((l: { serverId: string }) => l.serverId === server.id)
      },
      'the listing in the directory',
      60,
    )
    check(listed.name === 'Smoke Test World', `the directory calls it ${listed.name}`)

    // Someone else reports it, which is the only way an admin hears about it.
    const neighbour = await person(`smoke-neighbour-${Date.now()}@example.test`)
    await neighbour.api('listings.report', { serverId: server.id, reason: 'Testing the report path.' })
    const reports = await boss.api('admin.reports', {}, 'GET')
    check(
      reports.some((r: { serverId: string }) => r.serverId === server.id),
      'the report never reached the admins',
    )

    await boss.api('admin.moderate', { serverId: server.id, action: 'remove', note: 'Smoke run.' })
    const after = await api('listings.browse', { search: 'Smoke Test World', tag: null, offset: 0 }, 'GET')
    const still = after.listings.find((l: { serverId: string }) => l.serverId === server.id)
    check(still === undefined, 'the listing is still in the directory after removal')
    const own = await api('listings.own', { serverId: server.id }, 'GET')
    check(own.moderation === 'removed', `the owner sees its moderation as ${own.moderation}`)
    check(own.visible === false, 'the owner still sees it in the directory')
    return 'published, reported, removed'
  },
  300,
)

say('\nwhen things go wrong')
await step('comes back after its container is killed', async () => {
  const container = containerOf(server.id)
  check(run(['docker', 'kill', '-s', 'KILL', container]).ok, 'could not kill the container')
  const noticed = await waitFor(
    server.id,
    (v) => v.status === 'stopped' || v.status === 'crashed',
    'noticed the crash',
    180,
  )
  await api('servers.start', { serverId: server.id, requestId: randomUUID() })
  await waitFor(server.id, (v) => v.status === 'running', 'came back', 420)
  await settled(server.id, 420)
  const { output } = await api('console.run', { serverId: server.id, command: 'list' })
  check(/players online/.test(output), 'the console never came back')
  return `seen as ${noticed.status}${noticed.stopReason ? ` (${noticed.stopReason})` : ''}, then started again`
})

await step(
  'keeps its world when it is killed mid-save',
  async () => {
    const seedOf = async () => {
      const { output } = await api('console.run', { serverId: server.id, command: 'seed' })
      return String(output).match(/-?\d+/)?.[0] ?? ''
    }
    const before = await seedOf()
    check(before !== '', 'the server would not say what its seed is')
    // Saving writes the region files and level.dat, and a host that takes no care corrupts a
    // world by dying here. The same world has to come back.
    await api('console.run', { serverId: server.id, command: 'save-all' })
    check(run(['docker', 'kill', '-s', 'KILL', containerOf(server.id)]).ok, 'could not kill it')
    await waitFor(server.id, (v) => v.status === 'stopped' || v.status === 'crashed', 'stopped', 180)
    await settled(server.id, 300)
    await api('servers.start', { serverId: server.id, requestId: randomUUID() })
    await waitFor(server.id, (v) => v.status === 'running', 'came back up', 600)
    await settled(server.id, 600)
    const after = await seedOf()
    check(after === before, `it came back as a different world (${before} then ${after})`)
    const { out } = run(['docker', 'exec', containerOf(server.id), 'ls', '-l', '/data/world/level.dat'])
    check(/level\.dat/.test(out), `level.dat is gone: ${out}`)
    return `same world (seed ${before}), level.dat intact`
  },
  900,
)

await step(
  'wakes up when a player joins a sleeping world',
  async () => {
    await api('servers.stop', { serverId: server.id, requestId: randomUUID() })
    await waitFor(server.id, (v) => v.status === 'stopped', 'went to sleep', 300)
    await settled(server.id, 300)
    const took = await join(EDGE, `${server.slug}.play.localhost`, 'SmokeWaker', 180_000)
    await waitFor(server.id, (v) => v.status === 'running', 'woke up', 300)
    return `the player waited ${(took / 1000).toFixed(1)}s`
  },
  420,
)

if (QUICK) {
  skip('stops at an admin’s session cap', 'quick run')
} else {
  await step('stops at an admin’s session cap, warning in game first', async () => {
    await settled(server.id, 300)
    // No plan caps a run any more; an admin can still set one on an account.
    psql(
      `update account_standing set limit_overrides = limit_overrides || '{"maxSessionMinutes": 240}'
         where user_id = (select id from users where email = '${owner.email}')`,
    )
    const backdate = (minutes: number) => {
      psql(
        `insert into server_activity (server_id, last_player_at) values ('${server.id}', now())
           on conflict (server_id) do update set last_player_at = now()`,
      )
      psql(
        `update power_intervals set started_at = now() - interval '${minutes} minutes'
           where server_id = '${server.id}' and stopped_at is null`,
      )
    }
    const said = () => {
      const container = containerOf(server.id)
      const { out } = run(['docker', 'logs', '--tail', '400', container])
      return out.split('\n').filter((line) => line.includes('Server stops in'))
    }
    const waitUntil = async (done: () => boolean, what: string, seconds: number) => {
      const deadline = Date.now() + seconds * 1000
      while (Date.now() < deadline) {
        if (done()) return
        // The run has to keep looking played, or the empty-server idle stop wins the race.
        psql(`update server_activity set last_player_at = now() where server_id = '${server.id}'`)
        await Bun.sleep(2000)
      }
      throw new Error(`never ${what} within ${seconds}s`)
    }
    backdate(231)
    await waitUntil(() => said().length >= 1, 'said the ten-minute warning', 150)
    backdate(238)
    await waitUntil(() => said().length >= 2, 'said the two-minute warning', 150)
    backdate(241)
    const stopped = await waitFor(server.id, (v) => v.status === 'stopped', 'stopped at the cap', 300)
    check(stopped.stopReason === 'session_cap', `it stopped for ${stopped.stopReason}`)
    psql(
      `update account_standing set limit_overrides = limit_overrides - 'maxSessionMinutes'
         where user_id = (select id from users where email = '${owner.email}')`,
    )
    return said()
      .map((line) => line.replace(/^.*\[Rcon\] /, ''))
      .join(' | ')
  })
}

say('\nwhat to play, and what a link says')

/** The copied server, kept between two steps: one makes it, the other pictures it. */
let copy: { person: Person; id: string; slug: string } = null as never

// Each of these needs a server of its own, and the free plan sells one, so each gets its own
// account — which is also how a stranger meets any of this.
await step('a template decides the release, the server type and the world', async () => {
  const player = await person(`smoke-template-${Date.now()}@example.test`)
  const preview = await player.api(
    'servers.setupPreview',
    { from: { kind: 'template', key: 'hardcore' } },
    'GET',
  )
  check(preview.gameVersion !== '', 'the preview named no Minecraft version')
  check(preview.size.allowed === true, `a plain template should fit free: ${preview.size.reason}`)
  const made = await player.api('servers.create', {
    idempotencyKey: randomUUID(),
    name: 'One Life',
    partySize: '5',
    from: { kind: 'template', key: 'hardcore' },
  })
  const up = await waitFor(made.id, (v) => v.status === 'running', 'the template server came up', 420, player)
  check(up.gameVersion === preview.gameVersion, `it runs ${up.gameVersion}, not ${preview.gameVersion}`)
  const world = await player.api('worlds.list', { serverId: made.id }, 'GET')
  check(
    world.some((w: { active: boolean; hardcore: boolean }) => w.active && w.hardcore),
    'the hardcore template made a world that is not hardcore',
  )
  await player.api('servers.delete', { serverId: made.id, confirmName: 'One Life' })
  return `${preview.from} on ${up.gameVersion} ${up.loader}`
})

await step('a modpack brings its own version and server type, and says what it needs', async () => {
  const player = await person(`smoke-modpack-${Date.now()}@example.test`)
  const found = await player.api(
    'servers.searchModpacks',
    { text: 'vanilla perfected', offset: 0, limit: 5 },
    'GET',
  )
  check(found.length > 0, 'the catalogue found no modpack by that name')
  const preview = await player.api(
    'servers.setupPreview',
    { from: { kind: 'modpack', projectId: found[0].projectId } },
    'GET',
  )
  check(preview.modpack !== null, 'the preview came back without a pack')
  check(preview.gameVersion !== '' && preview.loader !== 'vanilla', 'a pack should bring a server type')
  // Every modpack is Plus's, a light one too: said before anything is made, with the plan named.
  check(
    preview.size.allowed === false && preview.size.plan === 'plus',
    `free was not offered Plus for a pack: ${preview.size.reason}`,
  )
  // A pack made for somebody's own game can never be a server, and is not offered as one.
  check(
    !found.some((hit: { slug: string }) => hit.slug === 'perfected-vanilla'),
    'a client-only pack was offered as something to make a server from',
  )
  // The other end: a kitchen-sink pack takes the largest size, and is refused in the same words,
  // with no gigabytes in them.
  const heavy = await player.api(
    'servers.searchModpacks',
    { text: 'all the mrcrayfishs mods', offset: 0, limit: 5 },
    'GET',
  )
  check(heavy.length > 0, 'the catalogue found no kitchen-sink pack')
  const refused = await player.api(
    'servers.setupPreview',
    { from: { kind: 'modpack', projectId: heavy[0].projectId } },
    'GET',
  )
  const said = refused.size.reason ?? ''
  check(refused.size.allowed === false && /Plus/.test(said), `free was not told: ${said}`)
  check(!/\d\s*GB|memory|RAM|heap/i.test(said), `the refusal talked about gigabytes: ${said}`)
  return `${preview.modpack.name} on ${preview.gameVersion} ${preview.loader}; heavy one refused: ${said}`
})

await step('a friend with an invite can make one like the server they were sent', async () => {
  const stranger = await person(`smoke-copier-${Date.now()}@example.test`)
  const { slug } = await view(server.id)
  // Through the invitation, which is the link the "Make one like this" button carries. The
  // directory is not involved: an admin took this server's listing down a few steps ago, and
  // copying it from the directory is refused for exactly that reason.
  const share = await api('sharing.own', { serverId: server.id }, 'GET')
  const invite = share.inviteUrl.split('/').pop() as string
  const from = { kind: 'server', slug, invite }
  const preview = await stranger.api('servers.setupPreview', { from }, 'GET')
  check(preview.gameVersion !== '', 'copying through an invite previewed nothing')
  // It runs a plugin, so a friend on Free is offered Plus for it rather than a server that won't run.
  check(
    preview.size.allowed === false && preview.size.plan === 'plus',
    'free could copy a server with a plugin',
  )
  check(boss !== null, 'there is no admin to change the plan')
  await boss.api('admin.setPlan', {
    userId: psql(`select id from users where email = '${stranger.email}'`).trim(),
    plan: 'plus',
  })
  const made = await stranger.api('servers.create', {
    idempotencyKey: randomUUID(),
    name: 'Like That One',
    partySize: '5',
    from,
  })
  const up = await waitFor(made.id, (v) => v.status === 'running', 'the copy came up', 420, stranger)
  const original = await view(server.id)
  check(
    up.gameVersion === original.gameVersion,
    `the copy runs ${up.gameVersion}, not ${original.gameVersion}`,
  )
  check(up.loader === original.loader, `the copy runs ${up.loader}, not ${original.loader}`)
  check(up.slug !== original.slug, 'the copy took the same address')
  copy = { person: stranger, id: made.id, slug: up.slug }
  return `${up.gameVersion} ${up.loader}, its own world`
})

await step('a server made for a day says when it goes, and is kept with one press', async () => {
  const player = await person(`smoke-temporary-${Date.now()}@example.test`)
  const made = await player.api('servers.create', {
    idempotencyKey: randomUUID(),
    name: 'Just Tonight',
    partySize: '5',
    from: { kind: 'template', key: 'survival' },
    temporary: true,
  })
  const seen = await player.api('servers.get', { serverId: made.id }, 'GET')
  check(seen.expiresAt !== null, 'a server made for a day has no end')
  const hours = (Date.parse(seen.expiresAt) - Date.now()) / 3_600_000
  check(hours > 23 && hours <= 24, `it goes in ${hours.toFixed(1)} hours`)
  const kept = await player.api('servers.keep', { serverId: made.id })
  check(kept.expiresAt === null, 'keeping it left the end in place')
  await waitFor(made.id, (v) => v.status === 'running', 'the temporary server came up', 420, player)
  await player.api('servers.delete', { serverId: made.id, confirmName: 'Just Tonight' })
  return `${hours.toFixed(1)} hours, then kept`
})

await step('a shared link carries a picture of that server', async () => {
  check(copy !== null, 'there is no server with a page to picture')
  // A page only exists once its owner opens it, which is the switch behind Share.
  await copy.person.api('listings.setPublic', { serverId: copy.id, public: true })
  const response = await fetch(`${WEB}/api/public/servers/${copy.slug}/card.png`)
  check(response.status === 200, `the picture answered ${response.status}`)
  check(response.headers.get('content-type') === 'image/png', 'it is not a PNG')
  const bytes = new Uint8Array(await response.arrayBuffer())
  check(bytes[0] === 0x89 && bytes[1] === 0x50, 'the bytes are not a PNG')
  // Width and height live in the IHDR, which is the first chunk.
  const width = new DataView(bytes.buffer).getUint32(16)
  const height = new DataView(bytes.buffer).getUint32(20)
  check(width === 1200 && height === 630, `it is ${width}x${height}`)
  await copy.person.api('servers.delete', { serverId: copy.id, confirmName: 'Like That One' })
  return `${width}x${height}, ${(bytes.length / 1024).toFixed(1)} kB`
})

say('\nwho a name belongs to')
await step('a server can stop checking accounts, and still lets in only the players it lists', async () => {
  const player = await person(`smoke-names-${Date.now()}@example.test`)
  const made = await player.api('servers.create', {
    idempotencyKey: randomUUID(),
    name: 'Names Only',
    partySize: '5',
  })
  const settledAs = (onlineMode: boolean, what: string) =>
    waitFor(
      made.id,
      (v) => v.status === 'running' && v.activeOperation === null && v.settings.onlineMode === onlineMode,
      what,
      420,
      player,
    )
  let seen = await settledAs(true, 'the server came up')
  const address = `${seen.slug}.play.localhost`
  const fresh = await login(EDGE, address, 'SmokeFriend')
  check(fresh === 'wants an account', `a new server did not ask for an account: ${fresh}`)

  await player.api('servers.changeAuthentication', {
    serverId: made.id,
    requestId: randomUUID(),
    version: seen.version,
    onlineMode: false,
  })
  seen = await settledAs(false, 'it came back without account checks')
  await player.api('access.setWhitelist', { serverId: made.id, enabled: true })
  await player.api('access.addToWhitelist', { serverId: made.id, name: 'SmokeFriend' })
  await until(
    async () => {
      const access = await player.api('access.get', { serverId: made.id }, 'GET')
      const listed = access.entries.some(
        (e: { player: { name: string }; state: string }) =>
          e.player.name === 'SmokeFriend' && e.state === 'active',
      )
      return access.whitelistEnabled && listed ? true : undefined
    },
    'the friend on the whitelist',
    120,
  )
  const friend = await login(EDGE, address, 'SmokeFriend')
  check(friend === 'let in', `the friend was ${friend}`)
  const stranger = await login(EDGE, address, 'SmokeIntruder')
  check(stranger.includes('not_whitelisted'), `a stranger was ${stranger}`)

  seen = await player.api('servers.get', { serverId: made.id }, 'GET')
  await player.api('servers.changeAuthentication', {
    serverId: made.id,
    requestId: randomUUID(),
    version: seen.version,
    onlineMode: true,
  })
  await settledAs(true, 'it came back checking accounts')
  const again = await login(EDGE, address, 'SmokeFriend')
  check(again === 'wants an account', `with accounts checked again, the friend was ${again}`)
  await player.api('servers.delete', { serverId: made.id, confirmName: 'Names Only' })
  return 'unchecked: the friend let in, a stranger turned away; checked again: an account asked for'
})

say('\nthe trash')
await step('goes to the trash and comes back', async () => {
  // Deleting asks for the name the server has now, which the directory step changed.
  const { name } = await view(server.id)
  await api('servers.delete', { serverId: server.id, confirmName: name })
  const trashed = await api('servers.trash', {}, 'GET')
  check(
    trashed.some((s: { id: string }) => s.id === server.id),
    'it never reached the trash',
  )
  await api('servers.undelete', { serverId: server.id })
  await waitFor(server.id, (v) => v.status !== 'deleted', 'came back from the trash', 300)
  return 'restored'
})

// ─── Afterwards ──────────────────────────────────────────────────────────────────────────────

if (KEEP) {
  say(`\nkept: ${owner.email} / ${owner.password}`)
} else {
  await step('leaves nothing behind', async () => {
    // Confirmed with the name it has now: a step renames it, and the old name deleted nothing, so
    // every run left a server behind until the local cap refused new ones.
    const { name } = await view(server.id)
    await api('servers.delete', { serverId: server.id, confirmName: name })
    psql(`update minecraft_servers set purge_after = now() where id = '${server.id}'`)
    // What a step that failed halfway left behind goes too: smoke accounts only ever hold test servers.
    psql(
      `update minecraft_servers s set status = 'deleted', deleted_at = now(), purge_after = now() from users u where u.id = s.owner_id and s.deleted_at is null and s.status in ('stopped', 'failed') and u.email like 'smoke%@example.test'`,
    )
    // Every admin is emailed each alert, and a run's admin is a made-up address: none outlives the
    // run, a crashed one's included.
    psql(`delete from platform_admins where granted_by = 'smoke'`)
    return 'its servers are in the trash, due to be purged, and no smoke admin is left'
  })
}

const summary = failures.length === 0 ? 'all good' : `${failures.length} failed: ${failures.join(', ')}`
say(`\n${summary}${skipped > 0 ? `, ${skipped} skipped` : ''} in ${ms(started)}`)
process.exit(failures.length === 0 ? 0 : 1)
