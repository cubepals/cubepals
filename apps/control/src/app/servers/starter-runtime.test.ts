// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world that starts on an archive, run the way a server starts: the step in a real shell, against
 * a folder standing in for the volume and a local server standing in for the server's link. It
 * unpacks the archive on the world's first start only, refuses other bytes, and leaves a world
 * that has begun alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARCADE_LEVEL, STARTER_STEP, starterEnv } from '../../minecraft/starter.ts'
import { levelTypeEnv } from '../../minecraft/worlds.ts'

/** An archive as the build packs one: a world's `level.dat` and a region, at its root. */
function archive(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'starter-src-'))
  mkdirSync(join(dir, 'dimensions/minecraft/overworld/region'), { recursive: true })
  writeFileSync(join(dir, 'level.dat'), 'level')
  writeFileSync(join(dir, 'dimensions/minecraft/overworld/region/r.0.0.mca'), 'region')
  const out = join(dir, 'world.tar.gz')
  spawnSync('tar', ['-czf', out, '-C', dir, 'level.dat', 'dimensions'])
  return readFileSync(out)
}

const ARCHIVE = archive()
const sha512 = createHash('sha512').update(ARCHIVE).digest('hex')
let fetched = 0
let links: Bun.Server<undefined>

beforeAll(() => {
  links = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      fetched += 1
      const name = new URL(request.url).pathname.slice(1)
      return name === 'world.tar.gz' ? new Response(ARCHIVE) : new Response('other bytes')
    },
  })
})
afterAll(() => links.stop(true))

/** Starts a server on `data` running `world` as far as the step, with the archive at `name`. */
async function start(data: string, name = 'world.tar.gz', hash = sha512): Promise<number> {
  return Bun.spawn(['/bin/sh', '-c', STARTER_STEP.replaceAll('/data', data)], {
    env: { LEVEL: 'world', BLOCKLY_STARTER: `${hash} http://127.0.0.1:${links.port}/${name}` },
    stderr: 'ignore',
  }).exited
}

describe('a world that starts on an archive', () => {
  test('its type names the archive and generates as the void beyond it', () => {
    const env = starterEnv(ARCADE_LEVEL, (artifact) => `https://links.test/${artifact.fileName}`)
    expect(env.BLOCKLY_STARTER).toMatch(/^[0-9a-f]{128} https:\/\/links\.test\/arcade-world\.tar\.gz$/)
    expect(levelTypeEnv(ARCADE_LEVEL).LEVEL_TYPE).toBe('minecraft:flat')
    expect(starterEnv('minecraft:normal', () => '')).toEqual({})
  })

  test('the first start unpacks it into the world, and a later one leaves the world alone', async () => {
    const data = mkdtempSync(join(tmpdir(), 'starter-'))
    expect(await start(data)).toBe(0)
    expect(readFileSync(join(data, 'world/level.dat'), 'utf8')).toBe('level')
    expect(readFileSync(join(data, 'world/dimensions/minecraft/overworld/region/r.0.0.mca'), 'utf8')).toBe(
      'region',
    )
    expect(readdirSync(data)).toEqual(['world'])

    writeFileSync(join(data, 'world/level.dat'), 'played')
    const before = fetched
    expect(await start(data)).toBe(0)
    expect(fetched).toBe(before)
    expect(readFileSync(join(data, 'world/level.dat'), 'utf8')).toBe('played')
  })

  test('other bytes stop the start, and leave nothing behind', async () => {
    const data = mkdtempSync(join(tmpdir(), 'starter-'))
    expect(await start(data, 'other.tar.gz')).not.toBe(0)
    expect(existsSync(join(data, 'world/level.dat'))).toBe(false)
    expect(readdirSync(data)).toEqual([])
  })
})
