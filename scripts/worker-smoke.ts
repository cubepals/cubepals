// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `bun scripts/worker-smoke.ts`: the Worker `worker:build` left in apps/web/.open-next, started
 * locally as wrangler would run it (`opennextjs-cloudflare preview`), asked for the site's pages
 * (lib/site-pages.ts). It fails when a page isn't 2xx or 3xx, or when the Worker prints an
 * exception. A build can succeed and bundle and still throw on every request (Next 16.4.0 did:
 * "Unexpected loadManifest(/.next/server/preview-props.json) call!"), which only running it shows.
 * The values are stand-ins; nothing leaves the machine.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ask, describe, isUp, websiteTargets } from './lib/site-pages.ts'

const WEB = join(import.meta.dir, '../apps/web')
const PORT = 8787
const ORIGIN = `http://127.0.0.1:${PORT}`
/** How long the Worker has to start answering. */
const START_SECONDS = 120

// A group of its own, so the whole tree (opennext, wrangler, workerd) is stopped together.
const preview = spawn(
  join(import.meta.dir, '../node_modules/.bin/opennextjs-cloudflare'),
  [
    'preview',
    '--port',
    String(PORT),
    '--var',
    'API_UPSTREAM:http://127.0.0.1:4000',
    '--var',
    `WEB_CANONICAL_ORIGIN:${ORIGIN}`,
  ],
  { cwd: WEB, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
)
let output = ''
for (const stream of [preview.stdout, preview.stderr])
  stream.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
const say = (line: string) => process.stdout.write(`${line}\n`)
const fail = (line: unknown) => process.stderr.write(`${String(line)}\n`)
const stop = () => {
  if (preview.pid !== undefined) process.kill(-preview.pid, 'SIGTERM')
}

/** Wrangler prints a request's uncaught error as `[wrangler:error]` or `✘ [ERROR]`, then the stack. */
const exceptions = () =>
  output.split('\n').filter((line) => /\[wrangler:error\]|\[ERROR\]|Uncaught|^\s*Error: /.test(line))

async function main(): Promise<boolean> {
  for (let waited = 0; !/Ready on http/.test(output); waited++) {
    if (preview.exitCode !== null || waited > START_SECONDS) {
      fail(`The Worker didn't start.\n${output.slice(-3000)}`)
      return false
    }
    await Bun.sleep(1000)
  }
  const answers = await ask(websiteTargets(ORIGIN))
  await Bun.sleep(1000)
  for (const answer of answers) say(`${isUp(answer) ? 'ok  ' : 'FAIL'} ${describe(answer)}`)
  const thrown = exceptions()
  if (thrown.length > 0) fail(`The Worker threw:\n${thrown.slice(0, 20).join('\n')}`)
  const down = answers.filter((answer) => !isUp(answer))
  if (down.length > 0 || thrown.length > 0) {
    if (down.length > 0)
      fail(`::error::The built Worker doesn't serve ${down.map((a) => a.target.name).join(', ')}.`)
    return false
  }
  return true
}

const ok = await main().catch((error) => {
  fail(error)
  return false
})
stop()
process.exit(ok ? 0 : 1)
