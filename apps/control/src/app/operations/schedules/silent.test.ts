// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The restart of a running server whose console goes silent (`silent.ts`), over passes read one
 * minute apart: when it comes, and the cases where it never does.
 */
import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { Actor } from '../../actor.ts'
import type { ObservedState, RuntimeHandle } from '../../ports/runtime.ts'
import { SILENT_MS, silentRestarts } from './silent.ts'

const handle = (id: string) => `h:${id}` as RuntimeHandle

/** A runtime, probe and service that say what they're told and keep what they're asked. */
function world(options: { state?: ObservedState; hostLost?: boolean; pings?: boolean } = {}) {
  const restarts: { actor: Actor; serverId: string; requestId: string }[] = []
  const execs: { handle: RuntimeHandle; command: readonly string[] }[] = []
  const silent = silentRestarts({
    runtime: {
      observe: async () => ({
        state: options.state ?? 'running',
        at: new Date(),
        hostLost: options.hostLost,
      }),
      endpoint: () => ({ host: 'server.internal', port: 25565 }),
      exec: async (h, command) => {
        execs.push({ handle: h, command })
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    probe: {
      ping: async () => {
        if (options.pings === true) return { online: 1, max: 10, version: '26.3' }
        throw new Error('no answer')
      },
    },
    service: {
      restart: async (actor, serverId, requestId) => {
        restarts.push({ actor, serverId, requestId })
        return {} as never
      },
    },
  })
  return { silent, restarts, execs }
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 18, 12) + minutes * MINUTE_MS)

/** One presence pass: each server's reading, then the end of the pass. */
async function pass(
  silent: ReturnType<typeof silentRestarts>,
  minutes: number,
  readings: Record<string, boolean>,
) {
  for (const [id, answered] of Object.entries(readings)) silent.note(id, handle(id), answered, at(minutes))
  return silent.settle(at(minutes))
}

describe('a running server whose console goes silent', () => {
  test('is restarted once it has been silent for five minutes, with a thread dump first', async () => {
    const { silent, restarts, execs } = world()
    await pass(silent, 0, { hung: true, other: true })
    for (let minute = 1; minute < 5; minute++)
      expect(await pass(silent, minute, { hung: false, other: true })).toBe(0)
    expect(restarts).toEqual([])
    expect(await pass(silent, SILENT_MS / MINUTE_MS, { hung: false, other: true })).toBe(1)
    expect(restarts).toEqual([
      {
        actor: { kind: 'system', reason: 'silent' },
        serverId: 'hung',
        requestId: `silent:${at(0).getTime()}`,
      },
    ])
    expect(execs).toEqual([{ handle: handle('hung'), command: ['pkill', '-QUIT', '-x', 'java'] }])
  })

  test('is heard again before it can be restarted again', async () => {
    const { silent, restarts } = world()
    await pass(silent, 0, { hung: true, other: true })
    await pass(silent, 5, { hung: false, other: true })
    expect(await pass(silent, 11, { hung: false, other: true })).toBe(0)
    await pass(silent, 12, { hung: true, other: true })
    expect(await pass(silent, 17, { hung: false, other: true })).toBe(1)
    expect(restarts.map((r) => r.requestId)).toEqual([
      `silent:${at(0).getTime()}`,
      `silent:${at(12).getTime()}`,
    ])
  })

  test('is never restarted for a run whose console this process never heard', async () => {
    const { silent, restarts } = world()
    for (let minute = 0; minute <= 30; minute++) await pass(silent, minute, { hung: false, other: true })
    expect(restarts).toEqual([])
  })

  test('starts its count again after it stopped running in between', async () => {
    const { silent, restarts } = world()
    await pass(silent, 0, { hung: true, other: true })
    await pass(silent, 1, { other: true })
    expect(await pass(silent, 6, { hung: false, other: true })).toBe(0)
    expect(restarts).toEqual([])
  })

  test('is left alone where nothing shows the control plane reaches it', async () => {
    const { silent, restarts } = world({ pings: false })
    await pass(silent, 0, { only: true })
    expect(await pass(silent, 10, { only: false })).toBe(0)
    // Every console silent at once is the control plane's network, not every game.
    await pass(silent, 0, { a: true, b: true })
    expect(await pass(silent, 10, { a: false, b: false })).toBe(0)
    expect(restarts).toEqual([])
  })

  test('is restarted alone on its machine where its game port still answers', async () => {
    const { silent, restarts } = world({ pings: true })
    await pass(silent, 0, { only: true })
    expect(await pass(silent, 5, { only: false })).toBe(1)
    expect(restarts.map((r) => r.serverId)).toEqual(['only'])
  })

  test('is left to the provider when it isn’t running, or its host is lost', async () => {
    for (const options of [
      { state: 'crashed' as const },
      { state: 'stopped' as const },
      { hostLost: true },
    ]) {
      const { silent, restarts } = world(options)
      await pass(silent, 0, { hung: true, other: true })
      expect(await pass(silent, 10, { hung: false, other: true })).toBe(0)
      expect(restarts).toEqual([])
    }
  })
})
