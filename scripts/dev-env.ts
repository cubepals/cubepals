// Writes .env from .env.example with fresh secrets in place of its public local-only ones. Leaves an
// existing .env alone. Optional: `cp .env.example .env` runs as it is.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SECRETS = ['REALTIME_TICKET_SECRET', 'RUNTIME_SECRETS_KEY', 'AUTH_SECRET', 'EDGE_TOKEN']

if (existsSync('.env')) {
  console.warn('.env already exists; not touching it')
  process.exit(0)
}

const lines = readFileSync('.env.example', 'utf8')
  .split('\n')
  .map((line) => {
    const key = line.split('=')[0] ?? ''
    return SECRETS.includes(key) && line.startsWith(`${key}=local-only-`)
      ? `${key}=${randomBytes(24).toString('base64url')}`
      : line
  })
writeFileSync('.env', lines.join('\n'))
console.warn('Wrote .env with fresh secrets')
