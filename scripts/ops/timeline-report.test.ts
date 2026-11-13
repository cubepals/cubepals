// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** One server's story in time order (`timeline-report.ts`), as `ops.ts timeline` prints it. */
import { describe, expect, test } from 'bun:test'
import type { OperationStepsView } from '@blockly/contracts'
import type { JoinView, SignalView } from '@blockly/contracts/join-records'
import { timelineReport } from './timeline-report.ts'

const SERVER = { id: '44da4279-50dd-47ee-8de9-58c665a1f41f', name: 'v0idworld', slug: 'v0idworld' }

const op = (o: Partial<OperationStepsView> & { kind: string; createdAt: string; steps: string[] }) =>
  ({
    id: crypto.randomUUID(),
    serverId: SERVER.id,
    serverName: SERVER.name,
    status: 'succeeded',
    step: null,
    error: null,
    detail: null,
    finishedAt: null,
    seconds: 54,
    ...o,
    steps: o.steps.map((step) => ({ step, at: o.createdAt, seconds: 0 })),
  }) as unknown as OperationStepsView

const join = (o: Partial<JoinView>) =>
  ({
    id: crypto.randomUUID(),
    kind: 'join',
    serverId: SERVER.id,
    serverName: SERVER.name,
    playerName: 'v0id',
    connectedAt: '2026-11-07T18:16:37.000Z',
    loginAt: null,
    inWorldAt: null,
    leftAt: null,
    leftReason: null,
    wakeOperationId: null,
    detail: {},
    ...o,
  }) as unknown as JoinView

describe('a server’s timeline', () => {
  test('its operations with why, its joins with how they ended, its signals, oldest first', () => {
    const report = timelineReport({
      server: SERVER,
      operations: [
        op({
          kind: 'start',
          createdAt: '2026-11-07T18:16:38.535Z',
          steps: [
            'queued',
            'attempt',
            'allocating',
            'other_spec',
            'changed:drift:image',
            'booting',
            'let_in',
          ],
        }),
        op({ kind: 'stop', createdAt: '2026-11-07T03:29:01.056Z', steps: ['attempt', 'slept'], seconds: 4 }),
      ],
      joins: [
        join({
          connectedAt: '2026-11-07T18:16:37.000Z',
          loginAt: '2026-11-07T18:17:33.000Z',
          inWorldAt: '2026-11-07T18:17:35.000Z',
          leftAt: '2026-11-07T19:02:00.000Z',
          leftReason: 'Timed out',
          wakeOperationId: 'x',
          detail: { session: { closedFirst: 'server', how: 'closed', quietAtEndMs: 24_000 } },
        }),
      ],
      signals: [
        {
          id: 1,
          kind: 'wake_booted',
          serverId: SERVER.id,
          joinId: null,
          at: '2026-11-07T18:18:00.000Z',
          detail: { server: 'v0idworld', reasons: ['other_spec'], changed: ['drift:image'] },
          closedAt: null,
          closedBy: null,
        } satisfies SignalView,
      ],
    })
    const lines = report.split('\n')
    expect(lines[0]).toBe(`v0idworld (v0idworld, ${SERVER.id})`)
    expect(lines[1]).toContain('03:29:01  op     stop')
    expect(lines[1]).toContain('(slept)')
    expect(lines[2]).toContain(
      '18:16:37  join   v0id  in the world in 58s; left 19:02:00 (Timed out), closed by the server side, player quiet 24s  woke it',
    )
    expect(lines[3]).toContain('18:16:38  op     start')
    expect(lines[3]).toContain('booted  (other_spec, changed:drift:image, let_in)')
    expect(lines[4]).toContain('18:18:00  signal wake_booted  reasons=other_spec changed=drift:image')
  })

  test('a join says how far it got only as far as someone saw', () => {
    const at = { connectedAt: '2026-11-07T08:33:29.000Z', leftAt: '2026-11-07T08:33:30.000Z' }
    const handed = { ...at, path: 'direct', handedAt: '2026-11-07T08:33:29.100Z' } as const
    const lines = timelineReport({
      server: SERVER,
      operations: [],
      signals: [],
      joins: [
        // On a server with no reporter, in the world for a while: nobody told of its login.
        join({ ...handed, playerName: 'played', serverSide: 'not_reported', bytesDown: 141_043_597 }),
        // The same server, and the game closed the login.
        join({ ...handed, playerName: 'kept-out', serverSide: 'not_reported', bytesDown: 182 }),
        // The same server, and its player list showed the player: no time says how long it took.
        join({
          ...handed,
          playerName: 'listed',
          serverSide: 'console',
          listedAt: '2026-11-07T08:34:02.000Z',
          leftAt: '2026-11-07T08:50:00.000Z',
        }),
        // Still not on that list a minute and more after it was handed over.
        join({
          ...handed,
          playerName: 'stuck',
          serverSide: 'not_reported',
          notListedAt: '2026-11-07T08:35:02.000Z',
          leftAt: '2026-11-07T08:36:00.000Z',
          bytesDown: 9_000,
        }),
        // A server whose reporter told of no login.
        join({ ...handed, playerName: 'silent', serverSide: 'reported', bytesDown: 0 }),
        // The edge's router connected it to nothing.
        join({
          ...at,
          playerName: 'dropped',
          path: 'refused',
          handedAt: null,
          leftReason: 'refused:missing-backend',
          serverSide: 'not_reported',
          bytesDown: 0,
        }),
      ],
    }).split('\n')
    const said = (who: string) => lines.find((line) => line.includes(`join   ${who}  `)) ?? ''
    expect(said('played')).toContain('handed to the server, which reports no login, 141043597 bytes back;')
    expect(said('kept-out')).toContain('handed to the server, which reports no login, 182 bytes back;')
    expect(said('listed')).toContain('in the world, on its player list by 08:34:02; left 08:50:00')
    expect(said('stuck')).toContain(
      'handed to the server, not on its player list at 08:35:02, 9000 bytes back;',
    )
    expect(said('silent')).toContain('never logged in;')
    expect(said('dropped')).toContain('not handed to the server; left 08:33:30 (refused:missing-backend)')
  })

  test('says when there is nothing in the window', () => {
    expect(timelineReport({ server: SERVER, operations: [], joins: [], signals: [] })).toContain(
      'nothing in this window',
    )
  })
})
