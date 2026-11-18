// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Copying worlds back from a volume's archive, as the game's container runs it, here on this
 * machine's sh, GNU tar, curl and od as the game's image has them: gzip or zstd, told apart by the
 * first bytes, and the world put back whole. A machine without zstd (this one may be) gets a
 * stand-in that inflates stdin as `zstd -dcq` does.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { until } from '@blockly/contracts/waits'
import { DATA_DIR } from '../../../minecraft/jars.ts'
import { bringWorldsBackCommand } from '../../../minecraft/worlds.ts'

let root = ''
let shims = ''
const archives = new Map<string, string>()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'blockly-worlds-back-'))
  shims = join(root, 'bin')
  await mkdir(join(root, 'w', 'world'), { recursive: true })
  await writeFile(join(root, 'w', 'world', 'level.dat'), 'archived')
  const tar = Bun.spawnSync(['tar', '-cf', join(root, 'w.tar'), '-C', join(root, 'w'), '.'])
  if (tar.exitCode !== 0) throw new Error('tar failed')
  const packed = await readFile(join(root, 'w.tar'))
  for (const [name, bytes] of [
    ['gzip', gzipSync(packed)],
    ['zstd', zstdCompressSync(packed)],
    ['neither', Buffer.from('not an archive')],
  ] as const) {
    await writeFile(join(root, `${name}.archive`), bytes)
    archives.set(name, `file://${join(root, `${name}.archive`)}`)
  }
  await mkdir(shims)
  if (Bun.spawnSync(['sh', '-c', 'command -v zstd']).exitCode !== 0) {
    await writeFile(
      join(shims, 'zstd'),
      `#!/bin/sh\nexec ${process.execPath} -e 'process.stdout.write(require("node:zlib").zstdDecompressSync(require("node:fs").readFileSync(0)))'\n`,
    )
    await chmod(join(shims, 'zstd'), 0o755)
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Copies `world` back from `archive` into a volume whose world says `current`; how it ended. */
async function back(archive: string): Promise<string> {
  const data = await mkdtemp(join(root, 'data-'))
  await mkdir(join(data, 'world'))
  await writeFile(join(data, 'world', 'level.dat'), 'current')
  const [shell = '', flag = '', script = '', ...args] = bringWorldsBackCommand(archive, ['world'])
  const here = script.replace(`cd ${DATA_DIR} `, `cd ${data} `)
  expect(here).not.toBe(script)
  Bun.spawnSync([shell, flag, here, ...args], {
    env: { ...process.env, PATH: `${shims}:${process.env.PATH}` },
  })
  const done = join(data, '.blockly-worlds-back.done')
  await until('the copy to say how it went', () => Bun.file(done).exists(), { timeoutMs: 20_000 })
  return `${(await readFile(done, 'utf8')).trim()} ${await readFile(join(data, 'world', 'level.dat'), 'utf8')}`
}

test('a gzip archive and a zstd one alike replace the world there', async () => {
  expect(await back(archives.get('gzip') ?? '')).toBe('0 archived')
  expect(await back(archives.get('zstd') ?? '')).toBe('0 archived')
})

test('an archive in neither leaves the world as it was', async () => {
  expect(await back(archives.get('neither') ?? '')).toBe('1 current')
})
