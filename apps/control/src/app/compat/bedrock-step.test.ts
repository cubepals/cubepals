// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The step that writes the key Floodgate shares with the edge, run in a real shell against a stand-in
 * for the volume, and the plugins Bedrock players need by release.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BEDROCK_STEP,
  bedrockPlugins,
  FLOODGATE,
  FLOODGATE_KEY_ENV,
  FLOODGATE_KEY_FILE,
  GEYSER_JAVA_VERSION,
} from '../../minecraft/bedrock.ts'
import { DATA_DIR } from '../../minecraft/jars.ts'
import { VIABACKWARDS, VIAVERSION } from '../../minecraft/mods.ts'

describe('the plugins Bedrock players need, by release', () => {
  test('a server on the release Geyser speaks needs Floodgate alone', () => {
    expect(bedrockPlugins(GEYSER_JAVA_VERSION)).toEqual([FLOODGATE])
  })

  test('an older release also needs ViaVersion, to take Geyser’s newer game', () => {
    for (const older of ['26.2', '26.1.2', '1.21.11', '1.21.1', '1.20.1'])
      expect(bedrockPlugins(older)).toEqual([FLOODGATE, VIAVERSION])
  })

  test('a newer release needs ViaBackwards too, to take Geyser’s older game', () => {
    expect(bedrockPlugins('26.4')).toEqual([FLOODGATE, VIAVERSION, VIABACKWARDS])
    expect(bedrockPlugins('27.1')).toEqual([FLOODGATE, VIAVERSION, VIABACKWARDS])
  })
})

describe('the step that writes the key', () => {
  const KEY = Buffer.from('0123456789abcdef')

  /** Runs the step in a stand-in for the volume, with the key (or none) in the environment. */
  const run = (volume: string, key: Buffer | null) => {
    const script = `unlinked() { :; }; ${BEDROCK_STEP.replaceAll(DATA_DIR, volume)} if printenv ${FLOODGATE_KEY_ENV} >/dev/null; then echo STILL_SET; fi`
    const result = Bun.spawnSync(['/bin/sh', '-c', script], {
      env: {
        PATH: process.env.PATH ?? '',
        ...(key === null ? {} : { [FLOODGATE_KEY_ENV]: key.toString('base64') }),
      },
    })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }

  test('writes the 16 bytes as they are, and never prints them', () => {
    const volume = mkdtempSync(join(tmpdir(), 'bedrock-step-'))
    const { code, out } = run(volume, KEY)
    expect(code).toBe(0)
    expect(out).not.toContain(KEY.toString('base64'))
    // The server the image starts next inherits no key: it is on the volume, not in its environment.
    expect(out).not.toContain('STILL_SET')
    const file = join(volume, FLOODGATE_KEY_FILE)
    expect(readFileSync(file)).toEqual(KEY)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('takes the key away when Bedrock is turned off, and leaves a key it did not write', () => {
    const volume = mkdtempSync(join(tmpdir(), 'bedrock-step-'))
    run(volume, KEY)
    expect(run(volume, null).out).not.toContain('STILL_SET')
    expect(() => statSync(join(volume, FLOODGATE_KEY_FILE))).toThrow()
    const own = join(volume, FLOODGATE_KEY_FILE)
    mkdirSync(join(volume, 'plugins/floodgate'), { recursive: true })
    writeFileSync(own, 'the owner’s own')
    expect(run(volume, null).code).toBe(0)
    expect(readFileSync(own, 'utf8')).toBe('the owner’s own')
  })

  test('writes a new key over an old one', () => {
    const volume = mkdtempSync(join(tmpdir(), 'bedrock-step-'))
    run(volume, KEY)
    const next = Buffer.from('fedcba9876543210')
    run(volume, next)
    expect(readFileSync(join(volume, FLOODGATE_KEY_FILE))).toEqual(next)
  })
})
