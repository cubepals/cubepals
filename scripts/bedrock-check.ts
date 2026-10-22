// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bedrock players on staging, end to end, from a machine that can send UDP (the Bedrock E2E
 * workflow's runner). Run it against a staging that is up and runs the Bedrock edge, with the
 * edge's BEDROCK_VALIDATE_LOGIN set to false, since its players are headless clients with no Xbox
 * account (`tools/bedrock-join`):
 *
 *   bun scripts/bedrock-check.ts
 *
 * It makes one account and one Paper server, and takes them through:
 *
 *   edge       health, Bedrock's status and a RakNet ping at the play address
 *   server     Bedrock on, Floodgate loaded with its key file (never printed)
 *   join       the server asleep, a Bedrock join waking it: spawn, time to spawn, a chat line, and
 *              a Java ping that sees the same server
 *   access     "Only people I add can join": an unlisted gamertag refused, an added one let in, a
 *              banned one refused
 *   forged     a Java handshake carrying Floodgate data reaches the server without it
 *   geyser     Geyser's process killed by its PID: Java joins and the edge's health carry on, and
 *              Geyser comes back
 *
 * Then the server goes to the trash and is purged. Every step is timed and ends in one table. The
 * private parts are reached as `staging-check.ts` reaches them: Postgres over `fly proxy`, the
 * edge's and the server's machines through flyctl.
 *
 * Not for turning the edge's sign-in check off or on, or starting and stopping staging: the
 * workflow does those around it, so they happen whatever this run does.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { MAIL_PORT } from '@blockly/contracts/local'
import { SQL } from 'bun'
import { runScheduledNow } from '../apps/control/src/infra/pg/jobs.ts'
import { GAME_PORT } from '../apps/control/src/minecraft/ports.ts'
import { offeredVersions } from '../apps/control/src/minecraft/versions.ts'
import { bedrockJoin, bedrockPing, knownGamertags } from './lib/bedrock-client.ts'
import { type StepResult, seconds, summaryTable } from './lib/check-progress.ts'
import { fly } from './lib/fly-async.ts'
import { type Edge, join, login, status } from './lib/minecraft.ts'
import { people } from './lib/people.ts'
import { reachDatabase } from './lib/staging-database.ts'

const WEB = 'https://staging.cubepals.com'
const PLAY_DOMAIN = 'play.staging.cubepals.com'
const EDGE_APP = 'bly-staging-edge'
const STATE_FILE = 'local/staging/state.json'
/** How long a server stays up with nobody on it, for this account only, against its plan's. */
const SLEEP_AFTER_MINUTES = 1
/** Gamertags GeyserMC's Xbox lookup is known to answer for; the first three it answers are used. */
const GAMERTAGS = ['Ninja', 'xbox', 'Dream', 'Shroud', 'Tfue']

const say = (line: string) => process.stdout.write(`${line}\n`)
const check = (held: boolean, complaint: string): void => {
  if (!held) throw new Error(complaint)
}

if (!existsSync(STATE_FILE) && !process.env.STAGING_STATE) {
  say('No staging to check: run bun scripts/staging.ts up first.')
  process.exit(2)
}
// A cloud environment carries what `up` made in STAGING_STATE (staging.ts env).
const state = JSON.parse(
  existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : (process.env.STAGING_STATE ?? '{}'),
) as { databaseUrl?: string; databasePassword?: string; authSecret: string }

const reached = await reachDatabase(state)
const database = new SQL(reached.url)
async function sql(statement: string): Promise<string> {
  const [row] = (await database.unsafe(statement).values()) as unknown[][]
  return row?.[0] == null ? '' : String(row[0])
}

const mail = Bun.spawn(['fly', 'proxy', `18025:${MAIL_PORT}`, '-a', 'bly-staging-mail'], {
  stdio: ['ignore', 'ignore', 'ignore'],
})
process.on('exit', () => mail.kill())
for (
  let i = 0;
  i < 30 &&
  !(await fetch('http://127.0.0.1:18025/api/v1/info').then(
    (r) => r.ok,
    () => false,
  ));
  i++
)
  await Bun.sleep(SECOND_MS)

const edgeV4 = (
  JSON.parse(await fly(['ips', 'list', '-a', EDGE_APP, '--json'])) as { Address: string; Type: string }[]
).find((ip) => ip.Type === 'v4')?.Address
if (!edgeV4) throw new Error('the edge has no IPv4')
const EDGE: Edge = { host: edgeV4, port: GAME_PORT }

// The same private domain `staging.ts` derives for the accounts staging lets sign up.
const CHECK_DOMAIN = `${createHash('sha256').update(state.authSecret).digest('hex').slice(0, 12)}.check.staging.blockly.test`
const CHECK_MARK = createHash('sha256').update(`staging-check:${state.authSecret}`).digest('hex')
const checkKey = () => `${CHECK_MARK.slice(0, 8)}-${CHECK_MARK.slice(8, 12)}-${randomUUID().slice(14)}`

const results: StepResult[] = []
const facts: string[] = []
const failures: string[] = []
const started = Date.now()

/** The running step's signal: aborted when it gives up, so what it left waiting stops with it. */
let current = new AbortController().signal

/** One step, timed; a failure is recorded and the run goes on with what doesn't depend on it. */
async function step(
  name: string,
  run: () => Promise<string | undefined>,
  limitSeconds = 900,
): Promise<boolean> {
  const at = Date.now()
  const gaveUp = new AbortController()
  current = gaveUp.signal
  try {
    const note = await Promise.race([
      run(),
      new Promise<never>((_, stop) =>
        setTimeout(() => {
          gaveUp.abort()
          stop(new Error(`gave up after ${limitSeconds}s`))
        }, limitSeconds * SECOND_MS).unref(),
      ),
    ])
    results.push({ name, ok: true, ms: Date.now() - at })
    say(`  ok   ${name}${note ? ` — ${note}` : ''}  (${seconds(Date.now() - at)})`)
    return true
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - at })
    failures.push(name)
    say(`  FAIL ${name} — ${(error as Error).message}  (${seconds(Date.now() - at)})`)
    return false
  }
}

/** Polls `read` until it answers something, or fails after `limitSeconds` saying what it waited for. */
async function until<T>(what: string, limitSeconds: number, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitSeconds * SECOND_MS
  for (;;) {
    if (current.aborted) throw new Error(`stopped waiting for ${what}: its step gave up`)
    const got = await read().catch(() => undefined)
    if (got !== undefined) return got
    if (Date.now() >= deadline) throw new Error(`never ${what} within ${limitSeconds}s`)
    await Bun.sleep(SECOND_MS)
  }
}

/** Where an edge's own pages answer: any name under the play domain reaches them. */
const edgePage = async (path: string) =>
  fetch(`https://bedrock-check.${PLAY_DOMAIN}${path}`, { redirect: 'manual' })
const bedrockStatus = async () =>
  (await (await edgePage('/_health/bedrock')).json()) as { state: string; bound: boolean; restarts: number }

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

say(`bedrock check: ${WEB}, players at <server>.${PLAY_DOMAIN}, UDP 19132`)
const owner = { email: `bedrock-${Date.now()}@${CHECK_DOMAIN}`, password: '' }
let api: Awaited<ReturnType<ReturnType<typeof people>['person']>>['api'] = async () => {
  throw new Error('no account yet')
}
let server = { id: '', slug: '' }
const address = () => `${server.slug}.${PLAY_DOMAIN}`
const view = () => api('servers.get', { serverId: server.id }, 'GET')
const waitFor = (
  want: (v: { status: string; activeOperation: unknown; stopReason?: string }) => boolean,
  what: string,
  limit = 600,
) =>
  until(what, limit, async () => {
    const now = await view()
    return want(now) ? now : undefined
  })
const consoleSays = async (command: string) =>
  String((await api('console.run', { serverId: server.id, command })).output ?? '')

try {
  await step('edge: healthy, Bedrock up, UDP 19132 answers a Bedrock ping', async () => {
    const health = await until('answered its health check', 180, async () => {
      const response = await edgePage('/_health')
      return response.status === 204 ? response : undefined
    })
    const bedrock = await until('Bedrock up', 240, async () => {
      const now = await bedrockStatus()
      return now.state === 'up' && now.bound ? now : undefined
    })
    const motd = await until('answered a Bedrock ping', 120, () =>
      bedrockPing(`bedrock-check.${PLAY_DOMAIN}`),
    )
    check(motd.startsWith('MCPE;'), `the ping answered "${motd.slice(0, 60)}"`)
    return `health ${health.status}, Bedrock ${bedrock.state} (bound ${bedrock.bound}, ${bedrock.restarts} restarts), pong "${motd.split(';').slice(0, 3).join(';')}"`
  })

  const signedUp = await step(
    'account signs up on staging and confirms through its mail catcher',
    async () => {
      const them = await people(WEB, 'http://127.0.0.1:18025').person(owner.email)
      // Cubepals' own test account, so the check takes none of staging's free places.
      await sql(
        `update account_standing set test_account = true where user_id = (select id from users where email = '${owner.email}')`,
      )
      owner.password = them.password
      api = them.api
      return owner.email
    },
  )

  const made =
    signedUp &&
    (await step('a Paper server is made with Bedrock on, Floodgate loaded with its key file', async () => {
      // The newest release Cubepals offers Paper on: the table servers.create checks, newest first.
      const release = offeredVersions().find((v) => v.loaders.includes('paper'))
      check(release !== undefined, 'the create flow offers Paper on no release')
      const created = await api('servers.create', {
        idempotencyKey: checkKey(),
        name: 'Bedrock Check',
        partySize: '5',
        regionKey: 'eu',
        playStyle: 'survival',
        loader: 'paper',
        gameVersion: release.id,
      })
      server = { id: created.id, slug: created.slug }
      const at = Date.now()
      await waitFor((v) => v.status === 'running', 'came up', 900)
      await waitFor((v) => v.activeOperation === null, 'settled', 600)
      const seen = await view()
      check(
        seen.bedrock?.on === true && seen.bedrock.needsOtherVersions === false,
        `Bedrock is ${JSON.stringify(seen.bedrock)}`,
      )
      const plugins = await consoleSays('plugins')
      check(/floodgate/i.test(plugins), `the server runs no Floodgate: ${plugins.slice(0, 120)}`)
      const log = await fly(['logs', '-a', `bly-staging-${server.id.replaceAll('-', '')}`, '--no-tail'])
      const loaded = log.split('\n').filter((line) => /floodgate/i.test(line))
      check(loaded.length > 0, 'its boot log says nothing of Floodgate')
      const failed = loaded.filter(
        (line) => /key\.pem|key file|error|exception|failed/i.test(line) && !/loaded|enabled/i.test(line),
      )
      check(
        failed.length === 0,
        `Floodgate complained of its key: ${failed[0]?.replace(/^.*?floodgate/i, 'floodgate').slice(0, 160)}`,
      )
      return `Paper on Minecraft ${release.id}, ${address()} (${server.id}) up in ${seconds(Date.now() - at)}; ${loaded.length} Floodgate log lines, none about its key`
    }))

  const slept =
    made &&
    (await step(
      'the server goes to sleep on its own',
      async () => {
        const account = `user_id = (select id from users where email = '${owner.email}')`
        await sql(
          `update account_standing set limit_overrides = limit_overrides || '{"idleShutdownAfterMinutes": ${SLEEP_AFTER_MINUTES}}' where ${account}`,
        )
        try {
          const asleep = await waitFor((v) => v.status === 'stopped', 'went to sleep', 1500)
          await waitFor((v) => v.activeOperation === null, 'settled', 600)
          check(asleep.stopReason === 'idle', `it stopped for ${asleep.stopReason}`)
          return `idle after ${SLEEP_AFTER_MINUTES} min on this account`
        } finally {
          await sql(
            `update account_standing set limit_overrides = limit_overrides - 'idleShutdownAfterMinutes' where ${account}`,
          )
        }
      },
      1600,
    ))

  if (slept) {
    await step(
      'a Bedrock player joins: the server wakes, they spawn, a chat line arrives',
      async () => {
        const chat = `hello from Bedrock ${randomUUID().slice(0, 8)}`
        const run = await bedrockJoin(
          address(),
          ['--chat', chat, '--hold', '15', '--timeout', '240'],
          current,
        )
        const [spawn] = run.spawnMs
        check(
          run.spawned === 1 && typeof spawn === 'number',
          `the player did not spawn: ${run.told[0]?.kicked ?? 'no answer'}`,
        )
        const heard = run.told[0]?.chat ?? []
        check(
          heard.some((line) => line.includes(chat)),
          `no chat line with "${chat}" reached the player; they heard ${JSON.stringify(heard)}`,
        )
        const now = await waitFor((v) => v.status === 'running', 'running', 120)
        facts.push(`Bedrock join from a sleeping server: ${seconds(spawn)} to spawn`)
        return `woke and spawned ${seconds(spawn)} after the join began; chat arrived (${heard.length} lines heard); server ${now.status}`
      },
      400,
    )

    await step(
      'a Java ping sees the same server while the Bedrock player is in',
      async () => {
        const holding = bedrockJoin(address(), ['--hold', '25', '--timeout', '120'], current)
        const seen = await until('showed the Bedrock player', 90, async () => {
          const ping = await status(EDGE, address())
          return (ping.players?.online ?? 0) >= 1 ? ping : undefined
        })
        const run = await holding
        check(run.spawned === 1, 'the Bedrock player did not stay in')
        return `Java sees ${seen.version.name}, ${seen.players?.online} online of ${seen.players?.max}`
      },
      200,
    )
  }

  let tags: [string, string][] = []
  if (slept)
    await step(
      'GeyserMC knows three gamertags for the access steps',
      async () => {
        tags = [...(await knownGamertags(GAMERTAGS, 3, current)).entries()]
        return tags.map(([name]) => name).join(', ')
      },
      60,
    )
  const [listed, unlisted, banned] = tags
  if (listed && unlisted && banned) {
    const joinsAs = ([name, xuid]: [string, string]) =>
      bedrockJoin(address(), ['--username', name, '--xuid', xuid, '--hold', '2', '--timeout', '60'], current)

    const ready = await step(
      '"Only people I add can join" is on, one gamertag added and one banned',
      async () => {
        await api('access.setWhitelist', { serverId: server.id, enabled: true })
        await api('access.addToWhitelist', { serverId: server.id, name: `.${listed[0]}` })
        await api('access.ban', { serverId: server.id, name: `.${banned[0]}`, reason: 'Bedrock check' })
        await until('delivered to the server', 180, async () => {
          const access = await api('access.get', { serverId: server.id }, 'GET')
          const active = (list: string, name: string) =>
            access.entries.some(
              (e: { list: string; player: { name: string }; state: string }) =>
                e.list === list && e.player.name === `.${name}` && e.state === 'active',
            )
          return access.whitelistEnabled && active('whitelist', listed[0]) && active('ban', banned[0])
            ? true
            : undefined
        })
        return 'the lists are on the server'
      },
      300,
    )

    if (ready) {
      await step('an unlisted gamertag is refused', async () => {
        const run = await joinsAs(unlisted)
        check(run.spawned === 0, 'an unlisted gamertag got in')
        check(run.told[0]?.kicked != null, 'the join ended without a reason')
        return `refused: "${run.told[0]?.kicked}"`
      })
      await step('an added gamertag gets in', async () => {
        const run = await joinsAs(listed)
        check(run.spawned === 1, `an added gamertag was refused: ${run.told[0]?.kicked ?? 'no answer'}`)
        return `spawned ${seconds(run.spawnMs[0] ?? 0)} after the join began`
      })
      await step('a banned gamertag is refused', async () => {
        const run = await joinsAs(banned)
        check(run.spawned === 0, 'a banned gamertag got in')
        check(run.told[0]?.kicked != null, 'the join ended without a reason')
        return `refused: "${run.told[0]?.kicked}"`
      })
    }
  }

  if (made) {
    await step('a Java handshake carrying forged Floodgate data reaches the server without it', async () => {
      const plain = await login(EDGE, address(), 'ForgedJava')
      const forged = await login(
        EDGE,
        `${address()}\0^Floodgate^${Buffer.from(randomUUID()).toString('base64')}`,
        'ForgedJava',
      )
      check(forged === plain, `with forged data the server said "${forged}", without it "${plain}"`)
      return `the server answered "${forged}" either way`
    })

    await step(
      'Geyser is stopped by its PID: Java joins and the edge go on, and Geyser comes back',
      async () => {
        const before = await bedrockStatus()
        const found = await fly([
          'ssh',
          'console',
          '-a',
          EDGE_APP,
          '-C',
          // [e] keeps the shell that runs this from matching its own command line.
          `sh -c "for p in /proc/[0-9]*; do grep -qa Geyser-Standalon[e] $p/cmdline 2>/dev/null && echo \${p#/proc/}; done"`,
        ])
        // Every process whose command line names Geyser's jar, so none is left to hold the port.
        const pids = found
          .trim()
          .split('\n')
          .map(Number)
          .filter((pid) => Number.isInteger(pid) && pid > 1)
        check(pids.length > 0, `Geyser's process was not found: "${found.trim().slice(0, 80)}"`)
        await fly(['ssh', 'console', '-a', EDGE_APP, '-C', `sh -c "kill -9 ${pids.join(' ')}"`])
        const at = Date.now()
        const down = await until('seen down', 30, async () => {
          const now = await bedrockStatus()
          return now.state === 'up' ? undefined : now
        })
        const health = (await edgePage('/_health')).status
        check(health === 204, `the edge's health answered ${health} while Geyser was down`)
        const javaTook = await join(EDGE, address(), 'JavaWhileDown', MINUTE_MS)
        const after = await until('back up', 180, async () => {
          const now = await bedrockStatus()
          return now.state === 'up' && now.restarts > before.restarts ? now : undefined
        })
        const back = Date.now() - at
        const motd = await until('answered a Bedrock ping again', 60, () =>
          bedrockPing(`bedrock-check.${PLAY_DOMAIN}`),
        )
        const again = await bedrockJoin(address(), ['--hold', '3', '--timeout', '120'], current)
        check(again.spawned === 1, 'a Bedrock player could not join after Geyser came back')
        facts.push(
          `Geyser killed: back ${seconds(back)} later (restarts ${before.restarts} to ${after.restarts})`,
        )
        return `pid ${pids.join(', ')} killed; Bedrock ${down.state}, edge health ${health}, a Java join took ${seconds(javaTook)}; Geyser up again after ${seconds(back)}, pong "${motd.split(';').slice(0, 2).join(';')}", a Bedrock join spawned`
      },
      600,
    )
  }
} finally {
  if (server.id !== '') {
    await step(
      'the server goes to the trash and is purged, and Fly holds nothing of it',
      async () => {
        await api('servers.delete', { serverId: server.id, confirmName: 'Bedrock Check' })
        await sql(
          `update minecraft_servers set purge_after = now() - interval '1 minute' where id = '${server.id}'`,
        )
        await runScheduledNow(reached.nodeUrl, 'purge-sweep')
        await until('purged', 600, async () =>
          (await sql(`select status from minecraft_servers where id = '${server.id}'`)) === 'purged'
            ? true
            : undefined,
        )
        const apps = JSON.parse(await fly(['apps', 'list', '-o', 'blockly-staging', '--json'])) as {
          Name: string
        }[]
        const app = `bly-staging-${server.id.replaceAll('-', '')}`
        check(!apps.some((a) => a.Name === app), `Fly still has ${app}`)
        return 'purged by the sweep; its Fly app is gone'
      },
      900,
    )
  }
}

say(`\n${facts.map((line) => `  ${line}`).join('\n')}`)
say(`\n${summaryTable(results, Date.now() - started).join('\n')}`)
say(
  `\n${failures.length === 0 ? 'all good' : `${failures.length} failed: ${failures.join(', ')}`} in ${seconds(Date.now() - started)}`,
)
process.exit(failures.length === 0 ? 0 : 1)
