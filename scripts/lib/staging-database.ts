// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Staging's database, for `scripts/staging.ts` and the scripts that check staging.
 *
 * By default it is Postgres 17 on a Fly Machine of its own, in the app bly-staging-db with a
 * volume, in the control plane's region. The control plane and the realtime app reach it over the
 * org's private network at `bly-staging-db.flycast`; Flycast also wakes the machine for a
 * connection, so a pull request's preview that wakes the stopped API finds its database. Nothing
 * outside the org can reach it: a script on a maintainer's machine or in CI goes through
 * `fly proxy`. It is started and stopped with the rest of staging, and not backed up: staging is
 * seeded again.
 *
 * `STAGING_DATABASE=supabase` brings back the Supabase staging project, through its session pooler
 * (`STAGING_DATABASE_URL`), which `up` leaves alone either way. That variable is the whole switch.
 *
 * Not for production, whose database is Fly's Managed Postgres and is never touched from here.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { verifiedAgainstSupabase } from './supabase-root.ts'

export const DATABASE_APP = 'bly-staging-db'
const IMAGE = 'mirror.gcr.io/library/postgres:17-alpine'
const VOLUME = 'pgdata'
const VOLUME_GB = 1
const USER = 'blockly'
const NAME = 'blockly'
const PORT = 5432
/** Supabase's root, as the control image carries it: node-postgres verifies the pooler against it. */
const SUPABASE_CA = '/app/packages/db/certs/supabase-root-2021.crt'

/** The part of staging's state the database reads and keeps. */
export interface DatabaseState {
  /** Supabase's session pooler, from STAGING_DATABASE_URL, which replaces it. */
  databaseUrl?: string
  /** Derived from the auth secret when missing, so every run of a state agrees on it. */
  databasePassword?: string
  authSecret: string
}

/** Which database staging uses. Every script that reaches it asks this, never the state. */
export const databaseKind = (): 'fly' | 'supabase' =>
  process.env.STAGING_DATABASE === 'supabase' ? 'supabase' : 'fly'

const passwordOf = (state: DatabaseState): string =>
  (state.databasePassword ??= createHash('sha256').update(`database:${state.authSecret}`).digest('base64url'))

const urlOn = (host: string, port: number, state: DatabaseState): string =>
  `postgres://${USER}:${passwordOf(state)}@${host}:${port}/${NAME}`

const supabaseUrl = (state: DatabaseState): string | undefined =>
  process.env.STAGING_DATABASE_URL ?? state.databaseUrl

/** Where the apps in the org reach the database. */
export const privateDatabaseUrl = (state: DatabaseState): string =>
  databaseKind() === 'fly' ? urlOn(`${DATABASE_APP}.flycast`, PORT, state) : (supabaseUrl(state) ?? '')

function fly(args: string[], allowFail = false, input?: string): string {
  const result = Bun.spawnSync(['fly', ...args], {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) return result.stdout.toString()
  if (allowFail) return ''
  const said = result.stderr.toString().trim().split('\n').slice(-2).join(' | ')
  throw new Error(`fly ${args.slice(0, 3).join(' ')}: ${said}`)
}

const machines = () =>
  (JSON.parse(fly(['machines', 'list', '-a', DATABASE_APP, '--json'], true) || '[]') as
    | { id: string; state: string }[]
    | null) ?? []

/** The machine is up and Postgres answers on TCP; the image's first-run server listens on its socket only. */
async function accepting(id: string, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const said = fly(
      ['machine', 'exec', id, '-a', DATABASE_APP, `pg_isready -h 127.0.0.1 -U ${USER} -d ${NAME}`],
      true,
    )
    if (said.includes('accepting connections')) return
    await Bun.sleep(1000)
  }
  throw new Error(`${DATABASE_APP}: not accepting connections within ${seconds}s`)
}

/** Every stopped machine of the database started, and waited for. A staging with none yet is left to `up`. */
export async function startDatabase(say: (line: string) => void): Promise<void> {
  if (databaseKind() !== 'fly') return
  for (const machine of machines()) {
    if (machine.state !== 'started') {
      fly(['machine', 'start', machine.id, '-a', DATABASE_APP])
      say(`  started ${DATABASE_APP} ${machine.id}`)
    }
    await accepting(machine.id, 120)
  }
}

/**
 * The database made if missing, running and accepting connections: the app, its private address,
 * the volume and the machine. What the password does is fixed when the volume is first used, so it
 * is read from the state on every run and set on the app only with the machine.
 * Returns the URL the control plane takes, and how many machines that adds to the platform's.
 */
export async function ensureDatabase(
  state: DatabaseState,
  org: string,
  region: string,
  say: (line: string) => void,
): Promise<{ url: string; machines: number }> {
  if (databaseKind() === 'supabase') {
    const found = supabaseUrl(state)
    if (!found) throw new Error('STAGING_DATABASE_URL (Supabase staging, session pooler) is not set')
    state.databaseUrl = found
    const url = new URL(found)
    url.searchParams.set('sslmode', 'verify-full')
    url.searchParams.set('sslrootcert', SUPABASE_CA)
    return { url: url.toString(), machines: 0 }
  }
  const apps = (JSON.parse(fly(['apps', 'list', '-o', org, '--json'])) as { Name: string }[]).map(
    (app) => app.Name,
  )
  if (!apps.includes(DATABASE_APP)) {
    fly(['apps', 'create', DATABASE_APP, '-o', org])
    say(`  made ${DATABASE_APP}`)
  }
  const ips = JSON.parse(fly(['ips', 'list', '-a', DATABASE_APP, '--json']) || '[]') as { Type: string }[]
  if (!ips.some((ip) => ip.Type === 'private_v6'))
    fly(['ips', 'allocate-v6', '--private', '-a', DATABASE_APP])
  if (machines().length === 0) {
    const volumes = JSON.parse(fly(['volumes', 'list', '-a', DATABASE_APP, '--json']) || '[]') as unknown[]
    if (volumes.length === 0)
      fly([
        'volumes',
        'create',
        VOLUME,
        '-a',
        DATABASE_APP,
        '-r',
        region,
        '-s',
        String(VOLUME_GB),
        '--scheduled-snapshots=false',
        '--snapshot-retention',
        '1',
        '-y',
      ])
    fly(
      ['secrets', 'import', '-a', DATABASE_APP, '--stage'],
      false,
      `POSTGRES_PASSWORD=${passwordOf(state)}\n`,
    )
    fly([
      'machine',
      'run',
      IMAGE,
      '-a',
      DATABASE_APP,
      '--name',
      'postgres',
      '--region',
      region,
      '--vm-size',
      'shared-cpu-1x',
      '--vm-memory',
      '256',
      '--volume',
      `${VOLUME}:/var/lib/postgresql/data`,
      // The volume's root holds lost+found, which initdb refuses to share a directory with.
      '--env',
      `PGDATA=/var/lib/postgresql/data/pgdata`,
      '--env',
      `POSTGRES_USER=${USER}`,
      '--env',
      `POSTGRES_DB=${NAME}`,
      // Flycast wakes the machine for a connection; only `stop` and the nightly stop it.
      '--port',
      `${PORT}:${PORT}/tcp`,
      '--autostart=true',
      '--autostop=off',
      '--restart',
      'always',
    ])
    say(`  made the database machine`)
  }
  await startDatabase(say)
  return { url: urlOn(`${DATABASE_APP}.flycast`, PORT, state), machines: 1 }
}

/**
 * What a script outside the org connects with: Supabase's pooler as it is, or a `fly proxy` to the
 * database app, opened here and closed when this process ends. `url` is for Bun's client and
 * `nodeUrl` for node-postgres, which wants Supabase's root to verify the pooler by.
 */
export async function reachDatabase(
  state: DatabaseState,
  localPort = 15432,
): Promise<{ url: string; nodeUrl: string }> {
  if (databaseKind() === 'supabase') {
    const url = supabaseUrl(state) ?? ''
    return { url, nodeUrl: verifiedAgainstSupabase(url) }
  }
  const child = spawn('fly', ['proxy', `${localPort}:${PORT}`, '-a', DATABASE_APP], { stdio: 'ignore' })
  process.on('exit', () => child.kill())
  const url = urlOn('127.0.0.1', localPort, state)
  for (let attempt = 0; attempt < 30; attempt++) {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: localPort,
      socket: { data() {}, open() {}, close() {}, error() {} },
    }).catch(() => undefined)
    socket?.end()
    if (socket) return { url, nodeUrl: url }
    await Bun.sleep(1000)
  }
  throw new Error(`fly proxy to ${DATABASE_APP} did not open on ${localPort}`)
}
