// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What is counted when a server is made, put to sleep, woken by the edge and joined: the real
 * control plane over the in-memory runtime, with a recording stand-in for the monitor.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Telemetry } from '../ports/telemetry.ts'
import { installTelemetry } from './telemetry.ts'

type Counted = { [K in keyof Telemetry]: Array<Parameters<Telemetry[K]>> }

const counted: Counted = {
  operationEnded: [],
  operationFailed: [],
  joinCompleted: [],
  wakeCompleted: [],
  wakeAnswered: [],
  requestServed: [],
  procedureServed: [],
  realtimeConnected: [],
  observeRealtime: [],
}
const recorder: Telemetry = {
  operationEnded: (...args) => void counted.operationEnded.push(args),
  operationFailed: (...args) => void counted.operationFailed.push(args),
  joinCompleted: (...args) => void counted.joinCompleted.push(args),
  wakeCompleted: (...args) => void counted.wakeCompleted.push(args),
  wakeAnswered: (...args) => void counted.wakeAnswered.push(args),
  requestServed: (...args) => void counted.requestServed.push(args),
  procedureServed: (...args) => void counted.procedureServed.push(args),
  realtimeConnected: (...args) => void counted.realtimeConnected.push(args),
  observeRealtime: (...args) => void counted.observeRealtime.push(args),
}

let h: Harness

beforeAll(async () => {
  if (hasDatabase) {
    h = await startHarness()
    h.runtime.sleeps.on = true
    installTelemetry(recorder)
  }
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

describe.skipIf(!hasDatabase)('what a server’s life counts', () => {
  test('the first build is timed, a wake is answered, and a join is timed from the handshake', async () => {
    const actor = await h.user('Steve', 'free')
    const server = await h.create(actor, { name: 'Sunset Valley' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(
      counted.operationEnded.some(([kind, outcome]) => kind === 'provision' && outcome === 'succeeded'),
    ).toBe(true)

    const hostname = `${server.slug}.play.test`
    expect((await h.app.edge.wake(hostname)).outcome).toBe('ready')
    expect(counted.wakeAnswered).toContainEqual(['ready', null])
    expect((await h.app.edge.wake('nobody.play.test')).outcome).toBe('denied')
    expect(counted.wakeAnswered).toContainEqual(['denied', 'unknown'])

    const joinId = crypto.randomUUID()
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
    await h.app.joins.recordVisits([
      {
        joinId,
        phase: 'open',
        edgeId: 'e1',
        region: 'fra',
        address: hostname,
        source: '203.0.113.9:51234',
        path: 'held',
        player: { name: 'Alex' },
        connectedAt: at(-30_000),
        wakeAskedAt: at(-29_000),
        readyAt: at(-9_000),
      },
      // The same half sent again is not a second wake.
      {
        joinId,
        phase: 'close',
        edgeId: 'e1',
        region: 'fra',
        address: hostname,
        source: '203.0.113.9:51234',
        readyAt: at(-9_000),
      },
    ])
    await h.app.joins.recordServerEvents(server.id, [
      { kind: 'login', at: at(-5_000), name: 'Alex', address: '203.0.113.9:51234' },
      { kind: 'in_world', at: at(0), name: 'Alex', address: '203.0.113.9:51234' },
      { kind: 'in_world', at: at(1_000), name: 'Alex', address: '203.0.113.9:51234' },
    ])
    expect(counted.wakeCompleted).toEqual([['fra', 20_000]])
    expect(counted.joinCompleted).toHaveLength(1)
    const [path, region, ms] = counted.joinCompleted[0] ?? []
    expect([path, region]).toEqual(['held', 'fra'])
    expect(ms).toBeGreaterThanOrEqual(29_000)
    expect(ms).toBeLessThan(31_000)
  })
})
