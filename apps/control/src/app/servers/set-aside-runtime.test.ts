// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The step that sets a file aside and puts it back, run by a real shell against a volume in a
 * temporary directory, with what a start's script defines before its steps. Which files it is given
 * is `set-aside.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SET_ASIDE_STEP, SET_ASIDE_VARIABLE, stillKept } from '../../minecraft/set-aside.ts'
import { UNLINKED } from '../../minecraft/volume-links.ts'

describe('setting a file aside, a copy kept', () => {
  let volume = ''
  let outside = ''

  beforeAll(async () => {
    volume = await mkdtemp(join(tmpdir(), 'blockly-aside-'))
    outside = await mkdtemp(join(tmpdir(), 'blockly-outside-'))
  })
  afterAll(async () => {
    await rm(volume, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const run = async (lines: string) => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LEVEL: 'world', [SET_ASIDE_VARIABLE]: lines }
    const script = `${UNLINKED} ${SET_ASIDE_STEP}`.replace(/\/data(?![A-Za-z])/g, volume)
    const step = Bun.spawn(['sh', '-c', script], { env, stderr: 'pipe' })
    return { exitCode: await step.exited, stderr: await new Response(step.stderr).text() }
  }
  const read = (path: string) => readFile(join(volume, path), 'utf8').catch(() => null)

  test('moves the file aside, and back when asked, never over one in its place', async () => {
    await mkdir(join(volume, 'world', 'datapacks'), { recursive: true })
    await writeFile(join(volume, 'world', 'datapacks', 'far-end.zip'), 'the pack')
    const aside = await run('aside world datapacks/far-end.zip')
    expect(aside.exitCode).toBe(0)
    expect(aside.stderr).toContain('Set aside world/datapacks/far-end.zip')
    expect(await read('world/datapacks/far-end.zip')).toBeNull()
    expect(await read('.blockly-set-aside/world/datapacks/far-end.zip')).toBe('the pack')
    // Asked again with nothing there, nothing changes.
    expect((await run('aside world datapacks/far-end.zip')).exitCode).toBe(0)
    expect(await read('.blockly-set-aside/world/datapacks/far-end.zip')).toBe('the pack')
    // Back, where nothing has taken its place.
    expect((await run('back world datapacks/far-end.zip')).stderr).toContain(
      'Put back world/datapacks/far-end.zip',
    )
    expect(await read('world/datapacks/far-end.zip')).toBe('the pack')
    // A jar under mods/, and one put back over a new file stays aside.
    await mkdir(join(volume, 'mods'), { recursive: true })
    await writeFile(join(volume, 'mods', 'jei.jar'), 'old copy')
    await run('aside server mods/jei.jar')
    await writeFile(join(volume, 'mods', 'jei.jar'), 'new copy')
    await run('back server mods/jei.jar')
    expect(await read('mods/jei.jar')).toBe('new copy')
    expect(await read('.blockly-set-aside/mods/jei.jar')).toBe('old copy')
  })

  test('what is still kept after a put back is read from the volume', async () => {
    const [program = 'sh', flag = '-c', script = ''] = stillKept(
      [
        { path: 'mods/jei.jar', inWorld: false },
        { path: 'datapacks/far-end.zip', inWorld: true },
      ],
      'world',
    )
    const step = Bun.spawn([program, flag, script.replace(/\/data(?![A-Za-z])/g, volume)], { stdout: 'pipe' })
    expect(await step.exited).toBe(0)
    // The jar stayed aside, since a new one took its place; the datapack went back.
    expect((await new Response(step.stdout).text()).trim()).toBe('server mods/jei.jar')
  })

  test('a line that isn’t one Blockly writes moves nothing', async () => {
    await writeFile(join(volume, 'server.properties'), 'motd=kept')
    const lines = [
      'aside server ../server.properties',
      'aside server /etc/hostname',
      'aside server .blockly-set-aside/mods/jei.jar',
      'aside elsewhere server.properties',
      'aside server mods/x;rm -rf .',
    ].join('\n')
    expect((await run(lines)).exitCode).toBe(0)
    expect(await read('server.properties')).toBe('motd=kept')
    expect(await read('.blockly-set-aside/mods/jei.jar')).toBe('old copy')
  })

  test('a link on the way is replaced, so nothing outside the volume moves', async () => {
    await writeFile(join(outside, 'precious.jar'), 'not the server’s')
    await rm(join(volume, 'mods'), { recursive: true, force: true })
    await symlink(outside, join(volume, 'mods'))
    const { stderr } = await run('aside server mods/precious.jar')
    expect(stderr).toContain('Cubepals replaced a link at mods')
    expect(await readFile(join(outside, 'precious.jar'), 'utf8')).toBe('not the server’s')
    expect(await readlink(join(volume, 'mods')).catch(() => null)).toBeNull()
  })
})
