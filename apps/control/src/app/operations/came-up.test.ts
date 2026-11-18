// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a boot does once it lets players in (`came-up.ts`): the server said running first, so a
 * player held while it woke is handed over, and only then its run read, which takes seconds.
 */
import { expect, test } from 'bun:test'
import { stays, until } from '@blockly/contracts/waits'
import type { LogLine } from '../ports/platform.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import { afterLetIn } from './came-up.ts'

const handle = 'came-up-runtime' as RuntimeHandle

/** A run's log that answers only once let go, as a read of a whole run's log takes seconds. */
function slowLog() {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const asked: number[] = []
  return {
    asked,
    release,
    logs: {
      recent: async (_handle: RuntimeHandle, lines: number): Promise<LogLine[]> => {
        asked.push(lines)
        await released
        return [{ at: new Date(), text: '[Server thread/ERROR]: Could not load plugin Missing.jar' }]
      },
    },
  }
}

test('the server is said running before its run is read, and nobody waits on the reading', async () => {
  const log = slowLog()
  const order: string[] = []
  const deps = {
    logs: log.logs,
    cameUp: async () => {
      order.push('came_up')
    },
  }
  const after = afterLetIn(deps, 'server', handle, [], [], async () => {
    order.push('running')
  })
  await until('the run’s log to be asked for', () => log.asked.length === 1)
  expect(order).toEqual(['running'])
  await stays('nothing read while the log is slow', () => order.length === 1, 200)
  log.release()
  await after
  expect(order).toEqual(['running', 'came_up'])
})

test('once the server runs, a reading that fails is logged; without that word it fails the boot', async () => {
  const deps = {
    logs: { recent: async () => [] },
    cameUp: async () => {
      throw new Error('the database went away')
    },
  }
  const said: string[] = []
  await afterLetIn(deps, 'server', handle, [], [], async () => {
    said.push('running')
  })
  expect(said).toEqual(['running'])
  await expect(afterLetIn(deps, 'server', handle, [], [])).rejects.toThrow('the database went away')
})

test('a running word that fails is the boot’s failure, and nothing is read after it', async () => {
  const log = slowLog()
  const deps = { logs: log.logs, cameUp: async () => {} }
  const failing = async () => {
    throw new Error('the transaction failed')
  }
  await expect(afterLetIn(deps, 'server', handle, [], [], failing)).rejects.toThrow('the transaction failed')
  await stays('the log never asked for', () => log.asked.length === 0, 200)
})
