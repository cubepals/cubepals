// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How many statements an idle control plane sends to Postgres in a minute:
 * `DATABASE_URL=postgres://… bun scripts/idle-statements.ts [seconds]`.
 *
 * It makes a database of its own on that server, migrates it, gives it a few accounts with servers
 * asleep, starts the control plane on it with `.env.example`'s local settings (every role), and
 * asks for routes once a second as an edge does. Once startup has settled it counts what
 * `pg_stat_statements` records for that database over the window, 60 s unless given, and prints
 * the total and the statements sent most. The database goes once it is counted. The server needs
 * `shared_preload_libraries = 'pg_stat_statements'`.
 *
 * Not a test: what counts as too many is read off its output, before and after a change.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { SECOND_MS } from '@blockly/contracts/durations'
import { EDGE_ID_HEADER, ROUTES_HELD_HEADER, ROUTES_VERSION_HEADER } from '@blockly/contracts/edge-poll'
import { SQL } from 'bun'

const base = process.env.DATABASE_URL
if (!base) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
const seconds = Number(process.argv[2] ?? 60)
/** Startup sends its own jobs and sweeps; the count starts once those are done. */
const SETTLE_SECONDS = 180
/** How many of the statements sent most are printed. */
const TOP = 40
/** Servers asleep, two to an account. */
const SERVERS = 14

/** Accounts, each with servers asleep on the local runtime, as a quiet deployment holds them. */
const SEED = `
  insert into users (id, name, email, email_verified)
    select 'idle-' || n, 'Idle ' || n, 'idle-' || n || '@example.test', true
    from generate_series(1, ${SERVERS / 2}) n;
  insert into account_standing (user_id) select id from users where id like 'idle-%';
  insert into minecraft_servers (id, owner_id, name, slug, region_key, memory_tier, status,
      create_idempotency_key, invite_code)
    select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'idle-' || ((n + 1) / 2),
      'Asleep ' || n, 'asleep-' || n, 'local', 'small', 'stopped', 'idle-' || n, 'idle' || n
    from generate_series(1, ${SERVERS}) n;
  insert into server_revisions (id, server_id, number, game_version, loader, settings, reason, created_by)
    select gen_random_uuid(), id, 1, '1.21.4', 'paper', '{}', 'created', owner_id
    from minecraft_servers;
  update minecraft_servers s set desired_revision_id = r.id from server_revisions r where r.server_id = s.id;
  insert into server_runtimes (server_id, provider) select id, 'docker' from minecraft_servers;
`

const name = `blockly_idle_${randomBytes(4).toString('hex')}`
const url = new URL(base)
url.pathname = `/${name}`
const admin = new SQL(base)
await admin.unsafe(`CREATE DATABASE ${name}`)
await admin`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`

const env: Record<string, string> = {
  ...(parseEnv(readFileSync('.env.example', 'utf8')) as Record<string, string>),
  ...process.env,
  DATABASE_URL: url.toString(),
}
delete env.DATABASE_DIRECT_URL
const say = (line: string) => console.warn(`idle-statements: ${line}`)
const run = (command: string[], cwd = '.') =>
  Bun.spawn(command, { cwd, env, stdout: 'ignore', stderr: 'inherit' })

/**
 * Asks for routes every second as an edge does (`apps/edge/poll.ts`): with the list it holds, so
 * only a changed one comes back. Asks that fail, as before the control plane listens, are retried.
 */
function asRoutes(internal: string, token: string): () => void {
  let held: { etag: string; version: string } | null = null
  const ask = async () => {
    const response = await fetch(`${internal}/edge/v1/routes`, {
      headers: {
        authorization: `Bearer ${token}`,
        [EDGE_ID_HEADER]: 'idle-statements',
        ...(held === null ? {} : { 'if-none-match': held.etag, [ROUTES_HELD_HEADER]: held.version }),
      },
    })
    if (response.status === 304 || !response.ok) return
    await response.arrayBuffer()
    held = {
      etag: response.headers.get('etag') ?? '',
      version: response.headers.get(ROUTES_VERSION_HEADER) ?? '',
    }
  }
  const timer = setInterval(() => void ask().catch(() => undefined), SECOND_MS)
  return () => clearInterval(timer)
}

let control: ReturnType<typeof run> | undefined
let edge: (() => void) | undefined
try {
  say(`migrating ${name}…`)
  if ((await run(['bun', 'run', 'db:migrate']).exited) !== 0) throw new Error('the migrations failed')
  const seeding = new SQL(url.toString())
  await seeding.unsafe(SEED).simple()
  await seeding.close()
  say('starting the control plane…')
  control = run(['node', 'src/main.node.ts'], 'apps/control')
  edge = asRoutes(`http://${env.INTERNAL_LISTEN}`, env.EDGE_TOKEN ?? '')
  await Bun.sleep(SETTLE_SECONDS * SECOND_MS)
  if (control.exitCode !== null) throw new Error('the control plane stopped')
  const [database] = await admin`SELECT oid FROM pg_database WHERE datname = ${name}`
  await admin`SELECT pg_stat_statements_reset(0, ${database.oid}, 0)`
  say(`counting for ${seconds} s…`)
  await Bun.sleep(seconds * SECOND_MS)
  const rows: Array<{ calls: string; rows: string; query: string }> = await admin`
    SELECT s.calls::text AS calls, s.rows::text AS rows, s.query FROM pg_stat_statements s
    WHERE s.dbid = ${database.oid} ORDER BY s.calls DESC`
  const total = rows.reduce((sum, row) => sum + Number(row.calls), 0)
  process.stdout.write(`${total} statements in ${seconds} s, ${rows.length} distinct\n`)
  for (const row of rows.slice(0, TOP))
    process.stdout.write(
      `${row.calls.padStart(6)} calls ${row.rows.padStart(7)} rows  ${row.query.replace(/\s+/g, ' ').slice(0, 110)}\n`,
    )
} finally {
  edge?.()
  control?.kill()
  await control?.exited
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.close()
}
