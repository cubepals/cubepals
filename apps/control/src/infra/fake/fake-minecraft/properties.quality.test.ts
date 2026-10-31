// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The fake game reads access from disk, preserving it while regenerating image configuration. */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { turnWhitelist, whitelistOn, writeProperties } from './properties.ts'

const directories: string[] = []
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'blockly-properties-quality-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('a missing properties file means the whitelist is off and leaves the directory unchanged', async () => {
  const dir = await directory()
  expect(await whitelistOn(dir)).toBe(false)
  await expect(readFile(join(dir, 'server.properties'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('only an exact white-list=true line enables the whitelist', async () => {
  const dir = await directory()
  const file = join(dir, 'server.properties')
  for (const text of [
    '',
    'white-list=false\n',
    'white-list=TRUE\n',
    'white-list=true-extra\n',
    'other-white-list=true\n',
    '# white-list=true\n',
  ]) {
    await writeFile(file, text)
    expect(await whitelistOn(dir)).toBe(false)
  }
  await writeFile(file, 'motd=Hello\nwhite-list=true\npvp=false\n')
  expect(await whitelistOn(dir)).toBe(true)
})

test('turning the whitelist on and off changes only its line', async () => {
  const dir = await directory()
  const file = join(dir, 'server.properties')
  await writeFile(file, 'motd=white-list=false\nwhite-list=false\npvp=false\n')
  await turnWhitelist(dir, true)
  expect(await readFile(file, 'utf8')).toBe('motd=white-list=false\nwhite-list=true\npvp=false\n')
  await turnWhitelist(dir, false)
  expect(await readFile(file, 'utf8')).toBe('motd=white-list=false\nwhite-list=false\npvp=false\n')
})

test('regenerating image properties preserves the on-disk whitelist and applies every environment field', async () => {
  const dir = await directory()
  const file = join(dir, 'server.properties')
  await writeFile(file, 'white-list=true\n')
  await writeProperties(dir, {
    DIFFICULTY: 'hard',
    MODE: 'creative',
    PVP: 'false',
    VIEW_DISTANCE: '12',
    SIMULATION_DISTANCE: '8',
    MAX_PLAYERS: '9',
    MOTD: 'Our world',
    SPAWN_PROTECTION: '2',
    LEVEL: 'island',
    ONLINE_MODE: 'FALSE',
    ENFORCE_WHITELIST: 'TRUE',
  })
  expect(await readFile(file, 'utf8')).toBe(
    'difficulty=hard\ngamemode=creative\npvp=false\nview-distance=12\nsimulation-distance=8\nmax-players=9\nmotd=Our world\nspawn-protection=2\nlevel-name=island\nonline-mode=false\nenforce-whitelist=true\nwhite-list=true\n',
  )
  expect(await whitelistOn(dir)).toBe(true)
})

test('a new image configuration uses defaults and an absent whitelist line stays off', async () => {
  const dir = await directory()
  const file = join(dir, 'server.properties')
  const expected =
    'difficulty=easy\ngamemode=survival\npvp=true\nview-distance=10\nsimulation-distance=10\nmax-players=20\nmotd=A Minecraft Server\nspawn-protection=16\nlevel-name=world\nonline-mode=true\nenforce-whitelist=false\nwhite-list=false\n'
  await writeProperties(dir, {})
  expect(await readFile(file, 'utf8')).toBe(expected)
  await writeFile(file, 'motd=previous configuration\n')
  await writeProperties(dir, {})
  expect(await readFile(file, 'utf8')).toBe(expected)
  expect(await whitelistOn(dir)).toBe(false)
})
