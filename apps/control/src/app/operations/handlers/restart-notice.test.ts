// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Word to players before a reboot is sent through the console, and never holds the reboot up. */
import { expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { kickEveryone } from '../../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import { NOTICE_WAIT_MS, RESTARTING, RESTARTING_FOR_A_CHANGE, restartNotice } from './restart-notice.ts'

const server = { id: 'server' } as MinecraftServer
const handle = { provider: 'fake', ref: 'machine' } as unknown as RuntimeHandle
const target: ConsoleTarget = { endpoint: { host: 'machine', port: 25575 }, passwords: ['secret'] }

type RunAll = ServerConsole['runAll']

/** A console that records what it was asked, then answers as `answer` does. */
const consoleThat = (answer: () => ReturnType<RunAll>) => {
  const asked: { target: ConsoleTarget; commands: readonly string[] }[] = []
  const runAll: RunAll = (to, commands) => {
    asked.push({ target: to, commands })
    return answer()
  }
  return { asked, console: { runAll } }
}

const answered = async () => [{ ok: true as const, output: 'Kicked Alex: bye' }]

test('everyone on the server is turned out with the reason, through its own console', async () => {
  const { asked, console } = consoleThat(answered)
  const targets: [MinecraftServer, RuntimeHandle][] = []
  const notice = restartNotice({
    console,
    consoleTarget: (s, h) => {
      targets.push([s, h])
      return target
    },
  })
  await notice.sendOff(server, handle, RESTARTING)
  expect(targets).toEqual([[server, handle]])
  expect(asked).toEqual([{ target, commands: kickEveryone(RESTARTING) }])
})

test('a console that fails, or no console to reach, never fails the reboot', async () => {
  const failing = consoleThat(async () => {
    throw new Error('Connection refused')
  })
  const notice = restartNotice({ console: failing.console, consoleTarget: () => target })
  await expect(notice.sendOff(server, handle, RESTARTING)).resolves.toBeUndefined()
  expect(failing.asked).toHaveLength(1)

  const unreachable = consoleThat(answered)
  const nowhere = restartNotice({
    console: unreachable.console,
    consoleTarget: () => {
      throw new Error('No console port')
    },
  })
  await expect(nowhere.sendOff(server, handle, RESTARTING)).resolves.toBeUndefined()
  expect(unreachable.asked).toEqual([])
})

test('a console that never answers holds the reboot up only as long as the wait', async () => {
  const { console } = consoleThat(() => new Promise(() => undefined))
  const notice = restartNotice({ console, consoleTarget: () => target, waitMs: 30 })
  const began = performance.now()
  await notice.sendOff(server, handle, RESTARTING)
  const took = performance.now() - began
  expect(took).toBeGreaterThanOrEqual(25)
  expect(took).toBeLessThan(SECOND_MS)
})

test('a console that answers within the wait is waited for, and nothing longer', async () => {
  let done = false
  const { console } = consoleThat(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    done = true
    return answered()
  })
  const notice = restartNotice({ console, consoleTarget: () => target })
  const began = performance.now()
  await notice.sendOff(server, handle, RESTARTING)
  expect(done).toBe(true)
  expect(performance.now() - began).toBeLessThan(NOTICE_WAIT_MS)
  expect(NOTICE_WAIT_MS).toBe(5 * SECOND_MS)
})

test('what players read says Cubepals, why, and that they can join again', () => {
  for (const reason of [RESTARTING, RESTARTING_FOR_A_CHANGE]) {
    expect(reason.startsWith('Cubepals is restarting this server')).toBe(true)
    expect(reason).toContain('join again')
    expect(reason).not.toMatch(/blockly|[\r\n]/i)
  }
  expect(RESTARTING_FOR_A_CHANGE).toContain('for a change')
  expect(RESTARTING).not.toContain('for a change')
})
