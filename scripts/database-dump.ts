// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production's database, dumped to a private R2 bucket that keeps each dump 30 days. The Database
 * dump workflow (.github/workflows/database-dump.yml) runs it every night, and docs/production.md
 * § Database dumps says how to restore one. It runs the same by hand, and against the dev stack:
 *
 *   bun scripts/database-dump.ts
 *
 * with DATABASE_URL (a session of its own: pg_dump can't run through a transaction pooler),
 * DUMP_S3_ENDPOINT, DUMP_S3_BUCKET, DUMP_S3_ACCESS_KEY_ID and DUMP_S3_SECRET_ACCESS_KEY, and
 * optionally DUMP_S3_REGION (auto) and DUMP_SIZE_LIMIT_MB (400). pg_dump and pg_restore must be the
 * server's major version or newer.
 *
 * It takes the dump, has pg_restore read it, uploads it under a dated key and checks the bucket holds
 * it whole. Then it fails if the database is past DUMP_SIZE_LIMIT_MB, so that a database nearing
 * Supabase Free's 500 MB is noticed before it fills. The dump is kept either way.
 *
 * The repository is public, and so are the workflow's logs: this prints sizes, the key and whether
 * each step passed, and takes the database's and the store's addresses out of any error. Never a row,
 * a URL or anything from the dump. With none of the values set it says the dump isn't set up and
 * stops without failing, which is production before `bun scripts/production.ts apply` sets them.
 *
 * It needs Bun and nothing installed, so the job that holds production's database installs no packages.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3Client, SQL } from 'bun'

const MB = 1024 * 1024
const NAMES = [
  'DATABASE_URL',
  'DUMP_S3_ENDPOINT',
  'DUMP_S3_BUCKET',
  'DUMP_S3_ACCESS_KEY_ID',
  'DUMP_S3_SECRET_ACCESS_KEY',
] as const

export interface DumpConfig {
  databaseUrl: string
  store: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }
  limitBytes: number
}

/** The run's values; null when none is set. Some but not all set is a mistake, and throws. */
export function configOf(env: Record<string, string | undefined>): DumpConfig | null {
  const missing = NAMES.filter((name) => !env[name])
  if (missing.length === NAMES.length) return null
  if (missing.length > 0) throw new Error(`${missing.join(', ')} not set.`)
  const limit = Number(env.DUMP_SIZE_LIMIT_MB || 400)
  if (!(limit > 0)) throw new Error('DUMP_SIZE_LIMIT_MB is a number of megabytes.')
  return {
    databaseUrl: env.DATABASE_URL ?? '',
    store: {
      endpoint: env.DUMP_S3_ENDPOINT ?? '',
      bucket: env.DUMP_S3_BUCKET ?? '',
      region: env.DUMP_S3_REGION || 'auto',
      accessKeyId: env.DUMP_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.DUMP_S3_SECRET_ACCESS_KEY ?? '',
    },
    limitBytes: limit * MB,
  }
}

/** The dump's key: the UTC time it was taken, so the bucket lists oldest first. */
export const dumpKey = (now: Date) => `blockly-${now.toISOString().slice(0, 19).replaceAll(':', '-')}Z.dump`

/** The major version in `pg_dump --version`'s answer, as `pg_dump (PostgreSQL) 17.6 (Ubuntu …)`. */
export function majorOf(versionLine: string): number | null {
  const match = /\(PostgreSQL\) (\d+)/.exec(versionLine)
  return match ? Number(match[1]) : null
}

/** How many entries `pg_restore --list` found: every line that isn't a comment. */
export const entriesIn = (list: string) =>
  list.split('\n').filter((line) => line.trim() !== '' && !line.startsWith(';')).length

export const megabytes = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`

/** Why the run fails for the database's size, or null while it is under the line. */
export function overLimit(bytes: number, limitBytes: number): string | null {
  if (bytes <= limitBytes) return null
  return (
    `The database is ${megabytes(bytes)}, past the ${megabytes(limitBytes)} line; Supabase Free holds ` +
    '500 MB. Make room, or move it to a bigger plan, before it fills. The dump was still taken.'
  )
}

/**
 * `text` with every part of the given URLs and values that could name or open them taken out:
 * whole values, a URL's user, password and host, and any IPv4 address an error quotes.
 */
export function redact(text: string, values: readonly string[]): string {
  const parts = new Set<string>()
  for (const value of values) {
    if (!value) continue
    parts.add(value)
    if (!URL.canParse(value)) continue
    const url = new URL(value)
    for (const part of [url.username, url.password, url.hostname].filter(Boolean)) {
      parts.add(part)
      parts.add(decoded(part))
    }
  }
  let out = text
  for (const part of [...parts].sort((a, b) => b.length - a.length)) out = out.replaceAll(part, '<redacted>')
  return out.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<address>')
}

/** A URL's part as it was before percent-encoding, or as it is when that is malformed. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

const say = (line: string) => process.stdout.write(`${line}\n`)

/** A Postgres tool's standard output. Its error, when it fails, is redacted where it is printed. */
function tool(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * MB })
  if (result.error) throw new Error(`${command}: ${result.error.message}. Is the Postgres client installed?`)
  if (result.status !== 0)
    throw new Error(`${command} failed (exit ${result.status}): ${result.stderr.trim()}`)
  return result.stdout
}

async function serverFacts(url: string): Promise<{ major: number; bytes: number }> {
  // Bun's client doesn't read `sslrootcert` from the URL as pg_dump does, so it is given the root.
  const root = new URL(url).searchParams.get('sslrootcert')
  const database = new SQL(root ? { url, tls: { ca: await Bun.file(root).text() } } : url)
  try {
    const [row] = (await database`
      select current_setting('server_version_num')::int / 10000 as major,
             pg_database_size(current_database()) as bytes`) as { major: number; bytes: string | number }[]
    return { major: Number(row?.major), bytes: Number(row?.bytes) }
  } finally {
    await database.close()
  }
}

async function dump(config: DumpConfig, work: string): Promise<void> {
  const server = await serverFacts(config.databaseUrl)
  const client = majorOf(tool('pg_dump', ['--version']))
  if (client === null || client < server.major)
    throw new Error(`pg_dump is ${client ?? 'unknown'}, older than the server's ${server.major}.`)
  say(`Database: ${megabytes(server.bytes)}, Postgres ${server.major}, dumped with pg_dump ${client}.`)

  const key = dumpKey(new Date())
  const file = join(work, key)
  tool('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    `--file=${file}`,
    `--dbname=${config.databaseUrl}`,
  ])
  const entries = entriesIn(tool('pg_restore', ['--list', file]))
  if (entries === 0) throw new Error('pg_restore reads the dump, and it holds nothing.')
  const bytes = statSync(file).size
  say(`Dumped: ${megabytes(bytes)}, ${entries} entries pg_restore can read.`)

  const store = new S3Client(config.store)
  await store.write(key, Bun.file(file), { type: 'application/octet-stream' })
  const stored = await store.stat(key)
  if (stored.size !== bytes) throw new Error(`The bucket holds ${stored.size} bytes of ${key}, not ${bytes}.`)
  say(`Uploaded ${key}, and the bucket holds all ${bytes} bytes of it.`)

  const over = overLimit(server.bytes, config.limitBytes)
  if (over) throw new Error(over)
  say(`Size: under the ${megabytes(config.limitBytes)} line.`)
}

if (import.meta.main) {
  const env = process.env
  const secrets = [
    env.DATABASE_URL,
    env.DUMP_S3_ENDPOINT,
    env.DUMP_S3_ACCESS_KEY_ID,
    env.DUMP_S3_SECRET_ACCESS_KEY,
  ]
  const work = mkdtempSync(join(tmpdir(), 'database-dump-'))
  try {
    const config = configOf(env)
    if (config === null)
      say("The database dump isn't set up: none of its values is set. production.ts apply sets them.")
    else await dump(config, work)
  } catch (error) {
    const message = redact(
      (error as Error).message,
      secrets.filter((s): s is string => Boolean(s)),
    )
    // In a workflow, the failure shows on the run's summary too.
    say(
      env.GITHUB_ACTIONS
        ? `::error title=Database dump::${message.replaceAll('%', '%25').replaceAll('\n', '%0A')}`
        : message,
    )
    process.exitCode = 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
