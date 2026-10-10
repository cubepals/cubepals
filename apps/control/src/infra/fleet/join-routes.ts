// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a new host fetches from the node endpoint before it has an identity, with no
 * authentication: nothing here is secret, and the host checks each piece before using it
 * (docs/fleet-operations.md, "Adding a node"; blocklyd's docs/protocol.md).
 *
 * - `GET /fleet/v1/ca.pem`: the fleet CA, fetched without trusting the connection and checked
 *   against the join token's hash.
 * - `GET /fleet/v1/join.sh`: join.sh, beside this file, with daemon.json written into it.
 * - `GET /fleet/v1/blocklyd` and `…/blocklyd.sha256`: the static blocklyd this control plane's
 *   image carries, and its hash in `sha256sum -c` form. A process without it starts as usual
 *   and answers 404, saying so.
 *
 * `blocklydRelease` says which version that blocklyd is, for the upgrade rollout
 * (registry/upgrades.ts). Enrollment and what follows it are node-endpoint.ts.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import type { UpgradeOffer } from './wire.ts'

/**
 * The version (from its `--version`) and sha256 of the blocklyd at `bin`, read once as the process
 * starts; null, saying why, when there is none or it doesn't run here.
 */
export async function blocklydRelease(bin: string): Promise<UpgradeOffer | null> {
  const binary = await readFile(bin).catch(() => null)
  if (binary === null) return null
  const printed = await promisify(execFile)(bin, ['--version'], { timeout: 10_000 }).catch((error: Error) => {
    console.error(`fleet: ${bin} --version failed, so no node is offered it: ${error.message}`)
    return null
  })
  const version = /^blocklyd (\S+)\s*$/.exec(printed?.stdout ?? '')?.[1]
  if (printed !== null && version === undefined)
    console.error(`fleet: ${bin} --version printed no version, so no node is offered it`)
  if (version === undefined) return null
  return { version, sha256: createHash('sha256').update(binary).digest('hex') }
}

export function joinRoutes(options: { caPem: string; blocklydBin: string }): Hono {
  const app = new Hono()
  // Read once, from beside this file: join.sh is the control plane's, and daemon.json is the pinned
  // blocklyd release's (scripts/blocklyd.ts).
  const daemonJson = readFileSync(new URL('./daemon.json', import.meta.url), 'utf8')
  const script = readFileSync(new URL('./join.sh', import.meta.url), 'utf8').replace(
    '@DAEMON_JSON@',
    daemonJson.trimEnd(),
  )
  const missing = (c: { text: (text: string, status: 404) => Response }) =>
    c.text(
      `This control plane has no blocklyd to hand out: ${options.blocklydBin} is missing. Its image carries ` +
        'one (apps/control/Dockerfile); elsewhere, set FLEET_BLOCKLYD_BIN to a static blocklyd.\n',
      404,
    )

  app.get('/fleet/v1/ca.pem', (c) => c.body(options.caPem, 200, { 'content-type': 'application/x-pem-file' }))
  app.get('/fleet/v1/join.sh', (c) => c.body(script, 200, { 'content-type': 'text/x-shellscript' }))
  app.get('/fleet/v1/blocklyd', async (c) => {
    const binary = await readFile(options.blocklydBin).catch(() => null)
    if (binary === null) return missing(c)
    return c.body(new Uint8Array(binary), 200, { 'content-type': 'application/octet-stream' })
  })
  app.get('/fleet/v1/blocklyd.sha256', async (c) => {
    const binary = await readFile(options.blocklydBin).catch(() => null)
    if (binary === null) return missing(c)
    return c.text(`${createHash('sha256').update(binary).digest('hex')}  blocklyd\n`)
  })
  return app
}
