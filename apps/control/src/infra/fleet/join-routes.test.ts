// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a joining host fetches from the node endpoint (join-routes.ts), as join.sh and `blocklyd
 * join` read it, and the release the upgrade rollout reads from the same binary.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blocklydRelease, joinRoutes } from './join-routes.ts'
import { caSha256 } from './join-token.ts'

describe('the join routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockly-join-'))
  const caPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
  const get = (blocklydBin: string, path: string) =>
    joinRoutes({ caPem, blocklydBin }).request(`https://endpoint/fleet/v1/${path}`)

  test('the CA is served byte for byte, so the token’s hash checks it', async () => {
    const served = await (await get('', 'ca.pem')).text()
    expect(caSha256(served)).toBe(caSha256(caPem))
  })

  test('join.sh carries daemon.json and is a script sh reads', async () => {
    const script = await (await get('', 'join.sh')).text()
    const daemonJson = readFileSync(new URL('daemon.json', import.meta.url), 'utf8')
    expect(script).toContain(daemonJson.trimEnd())
    expect(script).not.toContain('@DAEMON_JSON@')
    writeFileSync(join(dir, 'join.sh'), script)
    expect(spawnSync('sh', ['-n', join(dir, 'join.sh')]).status).toBe(0)
  })

  test('blocklyd and its sha256, in the form sha256sum -c reads', async () => {
    const bin = join(dir, 'blocklyd')
    writeFileSync(bin, 'a static blocklyd')
    const binary = Buffer.from(await (await get(bin, 'blocklyd')).arrayBuffer())
    expect(binary.toString()).toBe('a static blocklyd')
    const sum = await (await get(bin, 'blocklyd.sha256')).text()
    expect(sum).toBe(`${createHash('sha256').update(binary).digest('hex')}  blocklyd\n`)
  })

  test('without a blocklyd, both answer 404 and say why', async () => {
    for (const path of ['blocklyd', 'blocklyd.sha256']) {
      const answer = await get(join(dir, 'missing'), path)
      expect(answer.status).toBe(404)
      expect(await answer.text()).toContain('FLEET_BLOCKLYD_BIN')
    }
  })

  test('the release the rollout offers is the binary’s own version and sha256, or none', async () => {
    const bin = join(dir, 'versioned')
    writeFileSync(bin, '#!/bin/sh\necho "blocklyd 0.3.0"\n')
    chmodSync(bin, 0o755)
    expect(await blocklydRelease(bin)).toEqual({
      version: '0.3.0',
      sha256: createHash('sha256').update(readFileSync(bin)).digest('hex'),
    })
    expect(await blocklydRelease(join(dir, 'missing'))).toBeNull()
    const broken = join(dir, 'broken')
    writeFileSync(broken, '#!/bin/sh\nexit 1\n')
    chmodSync(broken, 0o755)
    expect(await blocklydRelease(broken)).toBeNull()
  })
})
