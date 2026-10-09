/**
 * The local stack, from a fresh clone: `bun run dev` (docs/local-development.md).
 *
 * In order: `.env` from `.env.example` when there is none yet, the dependencies (`bun install`,
 * which does nothing in a fraction of a second when `bun.lock` hasn't changed), the containers (`docker compose up`:
 * Postgres, Mailpit, the object store, the edge), the database's migrations, then the control
 * plane and the web app until Ctrl-C. Each step says what it did; one that fails stops here with
 * what to do about it, rather than leave the control plane to crash on a half-ready database.
 *
 * Local stays the default: `.env.lan`, which `bun run dev:lan` leaves behind, is emptied.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const say = (line: string) => console.warn(`dev: ${line}`)

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env')
  say('no .env yet, so it is a copy of .env.example now.')
}
// Emptied rather than removed: node's --watch stops at a missing --env-file-if-exists file.
writeFileSync('.env.lan', '# Empty: `bun run dev` serves localhost only. `bun run dev:lan` fills it.\n')
// What the shell already set wins, as it does for node's --env-file.
const env = { ...(parseEnv(readFileSync('.env', 'utf8')) as Record<string, string>), ...process.env }

function run(what: string, command: string[], help: string): void {
  say(`${what}…`)
  const done = Bun.spawnSync(command, { env, stdout: 'inherit', stderr: 'inherit' })
  if (done.exitCode === 0) return
  say(`${what} failed. ${help}`)
  process.exit(done.exitCode ?? 1)
}

// Every time, not only on a fresh clone: a pull that adds a package otherwise breaks every page
// with "Module not found" until someone thinks to install it.
run('installing the dependencies bun.lock lists', ['bun', 'install'], 'See what it said above.')
run(
  'starting the containers',
  ['docker', 'compose', 'up', '-d'],
  'Is Docker running? Start it, then run `bun run dev` again.',
)
// Postgres alone: `--wait` on everything counts the one-shot bucket setup finishing as a failure.
run(
  'waiting for the database',
  ['docker', 'compose', 'up', '-d', '--wait', 'postgres'],
  'See its log: `docker compose logs postgres`.',
)
run('applying the database migrations', ['bun', 'run', 'db:migrate'], 'Is the postgres container up?')

const dev = Bun.spawn(['bun', 'run', '--filter', '@blockly/control', '--filter', '@blockly/web', 'dev'], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => dev.kill(signal))
process.exit(await dev.exited)
