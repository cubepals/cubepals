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
 * It takes the dump, has pg_restore read it, encrypts it with age to DUMP_RECIPIENT, uploads it
 * under a dated key and checks the bucket holds it whole. The bucket only ever holds the encrypted
 * copy; the identity that opens it is kept in the private records. The job queue's finished jobs are left out: the jobs still to run, or holding their
 * server's queue, go beside it as `<key>.jobs.sql`, read in the same snapshot, which a restore runs
 * after the dump. Copying every finished job each night was most of what the dump read. Then it fails if the database is past DUMP_SIZE_LIMIT_MB, so that a database nearing
 * Supabase Free's 500 MB is noticed before it fills. The dump is kept either way.
 *
 * The repository is public, and so are the workflow's logs: this prints sizes, the key and whether
 * each step passed, and takes the database's and the store's addresses out of any error. Never a row,
 * a URL or anything from the dump. With none of the values set it says the dump isn't set up and
 * stops without failing, which is production before `bun scripts/production.ts apply` sets them.
 *
 * It needs Bun, the Postgres client and age, and nothing installed with a package manager of its
 * own, so the job that holds production's database runs no dependency's code.
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

/** The key of the jobs kept beside a dump, listed right after it. */
export const jobsKey = (dumpKey: string) => dumpKey.replace(/\.dump$/, '.jobs.sql')

/**
 * The age public key every dump is encrypted to before it leaves the job. A public key, so it lives
 * here; its identity, which decrypts, is kept in the private records (docs/production.md
 * § Restoring one). A new pair means a new value here; dumps made before stay with the old one.
 */
export const DUMP_RECIPIENT = 'age10va7efc7msmc20q6kqhq7ydsf6ngamaxn4y7ku9528wqf7gkpd9sgwwykq'

/** What the bucket keeps for a file: the file encrypted with age, named after it. */
export const sealedKey = (key: string) => `${key}.age`

/** The job queue's tables whose rows the dump leaves out: pg-boss's jobs, and what links them. */
const JOB_TABLES = ['pgboss.job*']

/**
 * The jobs a restore puts back: all but those that completed or were cancelled. A failed one is
 * kept, as a failed server operation holds its server's queue until an admin moves it.
 */
const KEPT_JOBS = "j.state not in ('completed', 'cancelled')"

/**
 * The SQL that puts `json`, the kept jobs as one JSON array, back into the job queue. It travels as
 * base64, which no quoting can break.
 */
export const jobsSql = (json: string) =>
  [
    "-- The job queue's jobs still to run, or holding their server's queue, as the dump was taken.",
    'insert into pgboss.job select * from json_populate_recordset(null::pgboss.job,',
    `  convert_from(decode('${Buffer.from(json).toString('base64')}', 'base64'), 'UTF8')::json);`,
    '',
  ].join('\n')

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
  if (result.error) throw new Error(`${command}: ${result.error.message}. Is ${command} installed?`)
  if (result.status !== 0)
    throw new Error(`${command} failed (exit ${result.status}): ${result.stderr.trim()}`)
  return result.stdout
}

/** A client of the database. Bun's doesn't read `sslrootcert` from the URL as pg_dump does, so it is given the root. */
async function connect(url: string): Promise<SQL> {
  const root = new URL(url).searchParams.get('sslrootcert')
  return new SQL(root ? { url, tls: { ca: await Bun.file(root).text() } } : url)
}

async function serverFacts(database: SQL): Promise<{ major: number; bytes: number }> {
  const [row] = (await database`
    select current_setting('server_version_num')::int / 10000 as major,
           pg_database_size(current_database()) as bytes`) as { major: number; bytes: string | number }[]
  return { major: Number(row?.major), bytes: Number(row?.bytes) }
}

/**
 * The dump and the jobs kept beside it, written to `file` and `jobsKey(file)`, both read in one
 * snapshot: what one holds, the other was taken with. Returns how many entries pg_restore reads in
 * the dump, and how many jobs were kept.
 */
export async function takeDump(
  database: SQL,
  url: string,
  file: string,
): Promise<{ entries: number; jobs: number }> {
  let jobs = 0
  await database.begin('isolation level repeatable read read only', async (tx) => {
    const [{ snapshot }] = (await tx`select pg_export_snapshot() as snapshot`) as { snapshot: string }[]
    tool('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--snapshot=${snapshot}`,
      ...JOB_TABLES.map((table) => `--exclude-table-data=${table}`),
      `--file=${file}`,
      `--dbname=${url}`,
    ])
    const [kept] = (await tx.unsafe(`
      select count(*)::int as n, coalesce(json_agg(j), '[]')::text as json
      from pgboss.job j where ${KEPT_JOBS}`)) as { n: number; json: string }[]
    jobs = kept?.n ?? 0
    await Bun.write(jobsKey(file), jobsSql(kept?.json ?? '[]'))
  })
  return { entries: entriesIn(tool('pg_restore', ['--list', file])), jobs }
}

/** `path` encrypted with age to DUMP_RECIPIENT, beside it; returns the encrypted file's path. */
function seal(path: string): string {
  const sealed = sealedKey(path)
  tool('age', ['--encrypt', '--recipient', DUMP_RECIPIENT, '--output', sealed, path])
  if (!(statSync(sealed).size > 0)) throw new Error(`age wrote nothing for ${path}.`)
  return sealed
}

/** Uploads `path` under `key`, and checks the bucket holds all of it. */
async function upload(store: S3Client, key: string, path: string): Promise<number> {
  const bytes = statSync(path).size
  await store.write(key, Bun.file(path), { type: 'application/octet-stream' })
  const stored = await store.stat(key)
  if (stored.size !== bytes) throw new Error(`The bucket holds ${stored.size} bytes of ${key}, not ${bytes}.`)
  return bytes
}

async function dump(config: DumpConfig, work: string): Promise<void> {
  const database = await connect(config.databaseUrl)
  try {
    const server = await serverFacts(database)
    const client = majorOf(tool('pg_dump', ['--version']))
    if (client === null || client < server.major)
      throw new Error(`pg_dump is ${client ?? 'unknown'}, older than the server's ${server.major}.`)
    say(`Database: ${megabytes(server.bytes)}, Postgres ${server.major}, dumped with pg_dump ${client}.`)

    const key = dumpKey(new Date())
    const file = join(work, key)
    const { entries, jobs } = await takeDump(database, config.databaseUrl, file)
    if (entries === 0) throw new Error('pg_restore reads the dump, and it holds nothing.')
    say(
      `Dumped: ${megabytes(statSync(file).size)}, ${entries} entries pg_restore can read, and ${jobs} jobs beside it.`,
    )

    const store = new S3Client(config.store)
    const [dumpAt, jobsAt] = [sealedKey(key), sealedKey(jobsKey(key))]
    const bytes = await upload(store, dumpAt, seal(file))
    const jobBytes = await upload(store, jobsAt, seal(jobsKey(file)))
    say(
      `Encrypted with age and uploaded ${dumpAt} and ${jobsAt}, and the bucket holds all ${bytes} and ${jobBytes} bytes of them.`,
    )

    const over = overLimit(server.bytes, config.limitBytes)
    if (over) throw new Error(over)
    say(`Size: under the ${megabytes(config.limitBytes)} line.`)
  } finally {
    await database.close()
  }
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
    // GitHub gives a secret that isn't there as an empty string. Production's values were set long
    // ago, so on this repository's own runs none of them arriving means they were lost, not unset.
    if (config === null && env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'cubepals/cubepals')
      throw new Error(
        "None of the database dump's values reached this run, so no dump was taken. Check the production environment's secrets; production.ts apply sets them.",
      )
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
