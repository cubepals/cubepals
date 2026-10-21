// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `ops.ts signals`, `join` and `joins` from outside, against a stand-in operators' API: the open
 * signals one a line and nothing else, nothing at all while none is open, so a script that polls it
 * sees a change only when one opens or closes; a join by its id or by a player; and a signal closed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { SignalView } from '@blockly/contracts/join-records'

const SECRET = 'operator-secret-0123456789'
const OPS = join(import.meta.dir, 'ops.ts')
// A version 4 id, as a join only the server reported has.
const JOIN_ID = '0b9d3c2e-4f1a-4c6b-9e2d-000000000001'

const SIGNAL: SignalView = {
  id: 12,
  kind: 'short_stay',
  serverId: 'server-1',
  joinId: JOIN_ID,
  at: '2026-10-20T09:05:00.000Z',
  detail: { server: 'Castle', player: 'Steve', address: 'castle.play.example', figure: 4.5, limit: 10 },
  closedAt: null,
  closedBy: null,
}

let open: SignalView[] = []
let paths: string[] = []
let api: ReturnType<typeof Bun.serve>

beforeAll(() => {
  api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const { pathname, search } = new URL(request.url)
      paths.push(`${request.method} ${pathname}${search}`)
      if (pathname === '/ops/v1/signals') return Response.json({ signals: open })
      if (pathname.endsWith('/close'))
        return Response.json({ ...SIGNAL, closedAt: SIGNAL.at, closedBy: 'operator:ada' })
      return Response.json({ joins: [] })
    },
  })
})
afterAll(() => api.stop(true))
beforeEach(() => {
  open = []
  paths = []
})

async function ops(args: string[]) {
  const run = Bun.spawn(['bun', OPS, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      OPERATOR_API: `http://127.0.0.1:${api.port}`,
      OPERATOR_TOKEN: SECRET,
      OPERATOR: 'ada',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  return { stdout, stderr, code }
}

describe('ops.ts signals', () => {
  test('prints nothing at all while no signal is open, and exits well', async () => {
    expect(await ops(['signals'])).toEqual({ stdout: '', stderr: '', code: 0 })
  })

  test('prints the open signals, one a line, oldest first, and nothing else', async () => {
    open = [
      SIGNAL,
      {
        ...SIGNAL,
        id: 13,
        kind: 'crowd',
        at: '2026-10-20T09:30:00.000Z',
        detail: { server: 'Castle', figure: 9, limit: 8 },
      },
    ]
    const { stdout, code } = await ops(['signals'])
    expect(code).toBe(0)
    expect(stdout).toBe(
      '#12 09:05 UTC Short stay · Castle · Steve via castle.play.example · 4.5 (limit 10)\n#13 09:30 UTC Crowd · Castle · 9 (limit 8)\n',
    )
  })

  test('--since asks for the closed ones too; close closes one by its number', async () => {
    await ops(['signals', '--since', '2026-10-13T00:00:00.000Z'])
    expect((await ops(['signals', 'close', '12'])).code).toBe(0)
    expect((await ops(['signals', 'close', 'twelve'])).code).toBe(1)
    expect(paths).toEqual([
      'GET /ops/v1/signals?since=2026-10-13T00%3A00%3A00.000Z',
      'POST /ops/v1/signals/12/close',
    ])
  })
})

describe('ops.ts join and joins', () => {
  test('a join by its id, or a player’s by name, uuid and moment', async () => {
    await ops(['join', JOIN_ID, '--json'])
    await ops(['join', 'Steve', '--json'])
    await ops(['join', '8667ba71-b85a-4004-af54-457a9734eed7', '--at', '2026-10-20T09:00:00.000Z', '--json'])
    await ops(['joins', '--server', 'castle', '--player', 'Steve', '--limit', '5'])
    expect(paths).toEqual([
      `GET /ops/v1/joins/find?player=${JOIN_ID}`,
      'GET /ops/v1/joins/find?player=Steve',
      'GET /ops/v1/joins/find?player=8667ba71-b85a-4004-af54-457a9734eed7&at=2026-10-20T09%3A00%3A00.000Z',
      'GET /ops/v1/joins?server=castle&player=Steve&limit=5',
    ])
  })
})
