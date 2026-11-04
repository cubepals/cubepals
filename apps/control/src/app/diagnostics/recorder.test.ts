// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work in hand and the recorder that keeps what ran slow or failed: what it keeps and lets go,
 * whose it says each was, its limits, and how it carries on when a write fails.
 */
import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { currentWork, note, within } from './context.ts'
import { type DiagnosticRecord, DiagnosticsRecorder, THRESHOLDS } from './recorder.ts'

const ACCOUNT = 'acct_1'
const SERVER = '3b1f5c2a-7d4e-4f6a-9b8c-1d2e3f4a5b6c'

/** A recorder whose writes land in `written`, at a clock the test moves. */
function recording(options: ConstructorParameters<typeof DiagnosticsRecorder>[2] = {}) {
  const written: DiagnosticRecord[] = []
  let now = new Date('2026-11-04T12:00:00.000Z')
  const recorder = new DiagnosticsRecorder('api', async (records) => void written.push(...records), {
    now: () => now,
    ...options,
  })
  return { recorder, written, later: (ms: number) => (now = new Date(now.getTime() + ms)) }
}

describe('work in hand', () => {
  test('is what was opened, with what came to be known, and nothing outside it', async () => {
    expect(currentWork()).toBeNull()
    await within({ origin: 'http:api /api/trpc/*' }, async () => {
      note({ requestId: 'r1', accountId: ACCOUNT })
      await within({ origin: 'trpc:servers.get', serverId: SERVER }, async () => {
        await Promise.resolve()
        expect(currentWork()).toMatchObject({
          origin: 'trpc:servers.get',
          requestId: 'r1',
          accountId: ACCOUNT,
          serverId: SERVER,
        })
      })
      // A procedure's server stays its own.
      expect(currentWork()?.serverId).toBeUndefined()
    })
    note({ accountId: 'nobody' })
    expect(currentWork()).toBeNull()
  })
})

describe('the recorder', () => {
  test('keeps a slow query with its shape and whose it was, and lets a quick one go', async () => {
    const { recorder, written } = recording()
    await within(
      { origin: 'trpc:servers.get', accountId: ACCOUNT, serverId: SERVER, requestId: 'r1' },
      async () => {
        recorder.query('select * from "minecraft_servers" where "id" = $1', THRESHOLDS.queryMs + 1, null)
        recorder.query('select 1', THRESHOLDS.queryMs - 1, null)
      },
    )
    await recorder.flush()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      kind: 'query',
      ms: THRESHOLDS.queryMs + 1,
      error: null,
      origin: 'trpc:servers.get',
      role: 'api',
      accountId: ACCOUNT,
      serverId: SERVER,
      requestId: 'r1',
      detail: { operation: 'SELECT', statement: 'select * from "minecraft_servers" where "id" = $n' },
    })
    expect(written[0]?.name).toMatch(/^q:/)
  })

  // What Postgres refuses with is a real refusal's, in `recording.test.ts`.
  test('keeps every failed query, however quick, with the first line of what it said', async () => {
    const { recorder, written } = recording()
    recorder.query('select 1', 2, new Error('Connection terminated unexpectedly\nat the socket'))
    await recorder.flush()
    expect(written.map((record) => [record.error, record.detail.message, record.origin])).toEqual([
      ['_OTHER', 'Connection terminated unexpectedly', 'process'],
    ])
  })

  test('keeps a slow procedure or request, and one answered with a 5xx, never a quick 4xx', async () => {
    const { recorder, written } = recording()
    recorder.served('procedure', 'servers.list', 200, THRESHOLDS.procedureMs)
    recorder.served('procedure', 'servers.get', 404, 5)
    recorder.served('procedure', 'servers.start', 500, 5)
    recorder.served('request', 'GET /api/health', 200, THRESHOLDS.requestMs + 1)
    recorder.served('request', 'GET /api/health', 200, 3)
    await recorder.flush()
    expect(written.map((record) => [record.kind, record.name, record.error])).toEqual([
      ['procedure', 'servers.list', null],
      ['procedure', 'servers.start', '500'],
      ['request', 'GET /api/health', null],
    ])
  })

  test('keeps at most so many a minute of one thing for one account, and so many in all, and counts the rest', async () => {
    const { recorder, written, later } = recording({ perKey: 2, perMinute: 3 })
    const slow = THRESHOLDS.queryMs * 2
    await within({ accountId: 'a' }, async () => {
      for (let i = 0; i < 5; i++) recorder.query('select 1', slow, null)
    })
    await within({ accountId: 'b' }, async () => {
      for (let i = 0; i < 5; i++) recorder.query('select 1', slow, null)
    })
    expect(recorder.dropped).toBe(7)
    later(MINUTE_MS)
    recorder.query('select 1', slow, null)
    await recorder.flush()
    expect(written.map((record) => record.accountId)).toEqual(['a', 'a', 'b', null])
  })

  test('holds no more than it may while writes wait, and never records its own writing', async () => {
    let wrote: (() => void) | null = null
    const written: DiagnosticRecord[] = []
    const recorder = new DiagnosticsRecorder(
      'worker',
      async (records) => {
        // The write's own slow query, as the pool would tell it.
        recorder.query('insert into "diagnostics" values ($1)', THRESHOLDS.queryMs * 10, null)
        await new Promise<void>((resolve) => (wrote = resolve))
        written.push(...records)
      },
      { held: 2, perKey: 100 },
    )
    recorder.query('select 1', THRESHOLDS.queryMs, null)
    const writing = recorder.flush()
    for (let i = 0; i < 3; i++) recorder.query('select 2', THRESHOLDS.queryMs, null)
    expect(recorder.dropped).toBe(1)
    ;(wrote as unknown as () => void)()
    await writing
    const rest = recorder.flush()
    ;(wrote as unknown as () => void)()
    await rest
    expect(written.map((record) => record.detail.statement)).toEqual(['select ?', 'select ?', 'select ?'])
  })

  test('counts what a failed write lost, and keeps on', async () => {
    let fail = true
    const written: DiagnosticRecord[] = []
    const recorder = new DiagnosticsRecorder('api', async (records) => {
      if (fail) throw new Error('the database is down')
      written.push(...records)
    })
    recorder.served('request', 'GET /x', 503, 1)
    await recorder.flush()
    expect(recorder.dropped).toBe(1)
    fail = false
    recorder.served('request', 'GET /x', 503, 1)
    await recorder.flush()
    expect(written).toHaveLength(1)
  })
})
