/**
 * The dev stack, served to the local network: `bun run dev:lan`.
 *
 * `bun run dev` answers only on localhost, which is this machine's own loopback — a phone or
 * another computer on the same Wi-Fi reaches its own loopback instead. This finds the address
 * this machine has on the network and runs the same stack with that address wherever a page, an
 * email link, a live connection, an upload or a Minecraft client needs to reach it. Localhost
 * keeps working beside it. The database and SMTP stay on loopback: nothing on another device
 * needs them.
 *
 * Players join <slug>.<ip>.nip.io, a public wildcard name that answers with the address inside
 * it — the edge routes by the name a client joins with, so a bare IP can't pick a server.
 *
 * The choice outlives this process: the settings go to `.env.lan` (ignored by git), which the
 * control plane reads after `.env` every time it starts, so a restart of any one part — a file
 * saved under `node --watch`, or one started by hand — comes back on the network rather than
 * quietly on localhost. `bun run dev` empties the file: local stays the default.
 */
import { networkInterfaces } from 'node:os'

const wanted = process.env.DEV_LAN_ADDRESS
const address =
  wanted ??
  Object.values(networkInterfaces())
    .flat()
    .find((net) => net !== undefined && net.family === 'IPv4' && !net.internal)?.address

if (address === undefined) {
  console.error(
    'No network address to serve on: is this machine on a network? Set DEV_LAN_ADDRESS to pick one.',
  )
  process.exit(1)
}

const web = `http://${address}:3000`
const lan = {
  // Pages, sign-in and the links in its emails, from anywhere on the network; localhost still works.
  WEB_CANONICAL_ORIGIN: web,
  WEB_TRUSTED_ORIGINS: [process.env.WEB_TRUSTED_ORIGINS, 'http://localhost:3000'].filter(Boolean).join(','),
  NEXT_ALLOWED_DEV_ORIGINS: address,
  // Live updates. A page at a network address is not a secure context, so browsers there use the
  // WebSocket fallback rather than WebTransport; both listen on every interface.
  REALTIME_LISTEN: '0.0.0.0:7443',
  REALTIME_PUBLIC_URL: `https://${address}:7443/`,
  REALTIME_FALLBACK_LISTEN: '0.0.0.0:7444',
  REALTIME_FALLBACK_URL: `ws://${address}:7444/transport-io`,
  REALTIME_TLS_HOSTNAME: address,
  // Uploads go straight from the page to the store, so the address it signs has to be reachable.
  ARCHIVE_S3_ENDPOINT: `http://${address}:9000`,
  // Joining from another device; the old play.localhost addresses keep working on this one.
  PLAY_DOMAIN: `${address}.nip.io`,
  PLAY_DOMAIN_ALIASES: 'play.localhost',
  // For docker compose: publish what other devices need, and let both origins upload.
  DEV_BIND: '0.0.0.0',
  DEV_WEB_ORIGINS: `http://localhost:3000 ${web}`,
}
const env = { ...process.env, ...lan }

await Bun.write(
  '.env.lan',
  `# Written by \`bun run dev:lan\`; \`bun run dev\` empties it.\n${Object.entries(lan)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`,
)

const compose = Bun.spawnSync(['docker', 'compose', 'up', '-d'], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (compose.exitCode !== 0) process.exit(compose.exitCode ?? 1)
// As `bun run dev` does: a database behind the code crashes the control plane at its first query.
Bun.spawnSync(['docker', 'compose', 'up', '-d', '--wait', 'postgres'], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})
const migrated = Bun.spawnSync(['bun', 'run', 'db:migrate'], { env, stdout: 'inherit', stderr: 'inherit' })
if (migrated.exitCode !== 0) process.exit(migrated.exitCode ?? 1)

console.warn(`
  Blockly on your network
    Pages      ${web}
    Mail       http://${address}:8025
    Players    <server-address>.${address}.nip.io
  Any device on this Wi-Fi can open these. A router that refuses public names pointing at private
  addresses (DNS rebinding protection) will not resolve the player address; the pages still work.
`)

// Not `bun run dev`, which is the local stack and empties `.env.lan`.
const dev = Bun.spawn(['bun', 'run', '--filter', '@blockly/control', '--filter', '@blockly/web', 'dev'], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => dev.kill(signal))
process.exit(await dev.exited)
