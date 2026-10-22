// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The supervision of Geyser: a child started again when it exits, and given only the environment it is named. */

import { expect, spyOn, test } from 'bun:test'
import { Supervised } from './geyser.ts'

test('a child that exits is started again, its lines in the agent’s logs behind its name', async () => {
  const logged: string[] = []
  const spy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    logged.push(parts.join(' '))
  })
  const child = new Supervised({
    command: ['bun', '-e', "console.log('\\x1b[36mhello\\x1b[0m'); process.exit(3)"],
    cwd: '.',
    env: { PATH: process.env.PATH ?? '' },
    prefix: '[geyser]',
    firstWaitMs: 20,
    longestWaitMs: 40,
  })
  const running = child.run()
  while (child.restarts < 2) await Bun.sleep(20)
  child.stop()
  await running
  spy.mockRestore()
  expect(logged.filter((line) => line === '[geyser] hello').length).toBeGreaterThanOrEqual(2)
  expect(logged.some((line) => line.startsWith('[geyser] exited with 3'))).toBe(true)
})

test('it is running while the child is, and stopping ends it for good', async () => {
  const child = new Supervised({
    command: ['bun', '-e', 'setInterval(() => {}, 1000)'],
    cwd: '.',
    env: { PATH: process.env.PATH ?? '' },
    prefix: '[geyser]',
  })
  const running = child.run()
  await Bun.sleep(100)
  expect(child.state).toBe('running')
  child.stop()
  await running
  expect(child.restarts).toBe(0)
})

test('the child sees the environment it is given and none of the agent’s own', async () => {
  process.env.FLOODGATE_KEY_FOR_TEST = 'a-secret'
  const logged: string[] = []
  const spy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    logged.push(parts.join(' '))
  })
  const child = new Supervised({
    command: [
      'bun',
      '-e',
      'console.log(JSON.stringify(Object.keys(process.env).filter((k) => !k.startsWith("BUN_")).sort())); setInterval(() => {}, 1000)',
    ],
    cwd: '.',
    env: { PATH: process.env.PATH ?? '', KEPT: 'yes' },
    prefix: '[geyser]',
  })
  const running = child.run()
  while (!logged.some((line) => line.includes('KEPT'))) await Bun.sleep(20)
  child.stop()
  await running
  spy.mockRestore()
  delete process.env.FLOODGATE_KEY_FOR_TEST
  const line = logged.find((l) => l.includes('KEPT')) ?? ''
  expect(line).toContain('KEPT')
  expect(line).not.toContain('FLOODGATE_KEY_FOR_TEST')
})
