// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

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
    prefix: '[geyser]',
  })
  const running = child.run()
  await Bun.sleep(100)
  expect(child.state).toBe('running')
  child.stop()
  await running
  expect(child.restarts).toBe(0)
})
