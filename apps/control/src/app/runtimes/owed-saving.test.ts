// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Saving retries use real fake-game console answers and preserve each endpoint's own debt. */
import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECOND_MS } from '@blockly/contracts/durations'
import { FakeMinecraft } from '../../infra/fake/fake-minecraft.ts'
import { FakeProfiles } from '../../infra/fake/fake-profiles.ts'
import { SAVE_OFF, SAVE_ON } from '../../minecraft/console.ts'
import { RCON_PORT } from '../../minecraft/ports.ts'
import { ConsoleUnavailable, type ServerConsole } from '../ports/minecraft.ts'
import type { RuntimeSpec } from '../ports/runtime.ts'
import { keepingSaving } from './owed-saving.ts'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'blockly-saving-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  mock.restore()
})

async function fixture(game = new FakeMinecraft(new FakeProfiles(), (handle) => handle as string)) {
  const spec: RuntimeSpec = {
    image: 'fixture',
    env: { VERSION: '26.3' },
    secrets: { RCON_PASSWORD: 'fixture' },
    resources: { memoryMb: 128 },
    storage: { mountPath: '/data', sizeGb: 1 },
    ports: [],
    stop: { signal: 'SIGTERM', timeoutSeconds: 1 },
    labels: {},
  }
  const key = crypto.randomUUID()
  await mkdir(join(root, key), { recursive: true })
  await game.start({ key, dir: join(root, key), host: key, spec })
  const target = { endpoint: { host: key, port: RCON_PORT }, passwords: ['fixture'] }
  const original = game.run.bind(game)
  let refusal: ConsoleUnavailable | undefined
  try {
    await original({ ...target, passwords: ['wrong'] }, SAVE_ON)
  } catch (error) {
    if (!(error instanceof ConsoleUnavailable)) throw error
    refusal = error
  }
  if (!refusal) throw new Error('The real console must refuse an incorrect password')
  const output = await original(target, 'list')
  const inner: ServerConsole = game
  return { game, inner, target, original, refusal, output, console: keepingSaving(inner) }
}

test('a failed save-on is retried before the next command and cleared once it succeeds', async () => {
  const f = await fixture()
  const run = spyOn(f.game, 'run').mockRejectedValueOnce(f.refusal)
  await expect(f.console.run(f.target, SAVE_ON)).rejects.toBe(f.refusal)
  expect(await f.console.run(f.target, 'list')).toBe(f.output)
  expect(await f.console.run(f.target, 'list')).toBe(f.output)
  expect(run.mock.calls.map((call) => call[1])).toEqual([SAVE_ON, SAVE_ON, 'list', 'list'])
})

test('a failed retry still forwards the requested command and remains owed', async () => {
  const f = await fixture()
  const run = spyOn(f.game, 'run').mockImplementation((target, command) =>
    command === SAVE_ON ? Promise.reject(f.refusal) : f.original(target, command),
  )
  await expect(f.console.run(f.target, SAVE_ON)).rejects.toBe(f.refusal)
  expect(await f.console.run(f.target, 'list')).toBe(f.output)
  expect(await f.console.run(f.target, 'list')).toBe(f.output)
  expect(run.mock.calls.map((call) => call[1])).toEqual([SAVE_ON, SAVE_ON, 'list', SAVE_ON, 'list'])
})

test.each([SAVE_ON, SAVE_OFF])('a successful %s clears the earlier saving debt', async (command) => {
  const f = await fixture()
  let failures = command === SAVE_OFF ? 2 : 1
  const run = spyOn(f.game, 'run').mockImplementation((target, asked) =>
    asked === SAVE_ON && failures-- > 0 ? Promise.reject(f.refusal) : f.original(target, asked),
  )
  await expect(f.console.run(f.target, SAVE_ON)).rejects.toBe(f.refusal)
  await f.console.run(f.target, command)
  expect(await f.console.run(f.target, 'list')).toBe(f.output)
  expect(run.mock.calls.map((call) => call[1])).toEqual(
    command === SAVE_ON ? [SAVE_ON, SAVE_ON, 'list'] : [SAVE_ON, SAVE_ON, SAVE_OFF, 'list'],
  )
})

test('a batch retains real results and options and retries saving before the next batch', async () => {
  const f = await fixture()
  f.game.refuseCommands(new RegExp(`^${SAVE_ON}$`))
  const expected = await f.game.runAll(f.target, [SAVE_ON, 'list'])
  const run = spyOn(f.game, 'run')
  const all = spyOn(f.inner, 'runAll')
  const options = { commandMs: SECOND_MS }
  expect(await f.console.runAll(f.target, [SAVE_ON, 'list'], options)).toEqual(expected)
  expect(all.mock.calls[0]).toEqual([f.target, [SAVE_ON, 'list'], options])
  f.game.refuseCommands(null)
  expect(await f.console.runAll(f.target, ['list'])).toEqual([{ ok: true, output: f.output }])
  expect(run.mock.calls.map((call) => call[1])).toEqual([SAVE_ON])
})

test('an unrelated command failure creates no saving debt', async () => {
  const f = await fixture()
  const run = spyOn(f.game, 'run').mockRejectedValueOnce(f.refusal)
  await expect(f.console.run(f.target, 'list')).rejects.toBe(f.refusal)
  expect(await f.console.run(f.target, 'list')).toBe(f.output)
  expect(run.mock.calls.map((call) => call[1])).toEqual(['list', 'list'])
})

test('host and port both distinguish the consoles that owe a save-on', async () => {
  const f = await fixture(),
    other = await fixture(f.game)
  const run = spyOn(f.game, 'run').mockRejectedValueOnce(f.refusal)
  await expect(f.console.run(f.target, SAVE_ON)).rejects.toBe(f.refusal)
  await f.console.run({ ...f.target, endpoint: { ...f.target.endpoint, port: RCON_PORT + 1 } }, 'list')
  await f.console.run(other.target, 'list')
  await f.console.run(f.target, 'list')
  expect(run.mock.calls.map((call) => call[1])).toEqual([SAVE_ON, 'list', 'list', SAVE_ON, 'list'])
})
