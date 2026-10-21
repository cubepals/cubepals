// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A join as an incident report, and the one-line forms, on a fixed join (`join-report.ts`). */
import { expect, test } from 'bun:test'
import type { JoinDetailView, JoinView, SignalView } from '@blockly/contracts/join-records'
import { joinLine, joinReport, signalLine } from './join-report.ts'

const JOIN: JoinView = {
  id: '01900000-0000-7000-8000-000000000001',
  kind: 'join',
  serverId: 'server-1',
  serverName: 'Castle',
  edgeId: 'edge-1',
  edgeRegion: 'fra',
  address: 'castle.play.example',
  addressKind: 'own',
  protocol: 772,
  playerName: 'Steve',
  playerUuid: '8667ba71-b85a-4004-af54-457a9734eed7',
  path: 'held',
  pingedAt: '2026-10-20T15:43:20.000Z',
  connectedAt: '2026-10-20T15:43:21.000Z',
  wakeAskedAt: '2026-10-20T15:43:21.200Z',
  wakeOperationId: 'op-1',
  readyAt: '2026-10-20T15:44:01.000Z',
  handedAt: '2026-10-20T15:44:01.500Z',
  loginAt: '2026-10-20T15:44:02.000Z',
  configureStartedAt: null,
  configuredAt: null,
  inWorldAt: '2026-10-20T15:45:31.000Z',
  leftAt: '2026-10-20T15:50:00.000Z',
  leftReason: 'disconnected',
  pingedAfterAt: null,
  bytesUp: 4_000,
  bytesDown: 900_000,
  tick: { tps: 19.9, mspt: 31.5, online: 3 },
  serverSide: 'reported',
  detail: {},
}

const SLOW: SignalView = {
  id: 7,
  kind: 'slow_join',
  serverId: 'server-1',
  joinId: JOIN.id,
  at: '2026-10-20T15:46:00.000Z',
  detail: { server: 'Castle', player: 'Steve', address: 'castle.play.example', figure: 89, limit: 30 },
  closedAt: null,
  closedBy: null,
}

const VIEW: JoinDetailView = {
  join: JOIN,
  wake: {
    id: 'op-1',
    kind: 'start',
    status: 'succeeded',
    createdAt: '2026-10-20T15:43:21.300Z',
    finishedAt: '2026-10-20T15:44:00.800Z',
    steps: [
      { step: 'attempt', at: '2026-10-20T15:43:21.400Z' },
      { step: 'booting', at: '2026-10-20T15:43:25.000Z' },
    ],
  },
  signals: [SLOW],
  joinsOnServer: 4,
}

test('a join reads as an incident report, every step in order with its time', () => {
  expect(joinReport(VIEW)).toEqual([
    '# Castle: Steve, 2026-10-20 15:43:21 UTC',
    '',
    '## Who',
    '',
    '- Steve (8667ba71-b85a-4004-af54-457a9734eed7)',
    '- Game protocol: 772',
    '- Joins of this server in the last 35 days: 4',
    '',
    '## How they reached us',
    '',
    '- Address: castle.play.example',
    '- Edge: edge-1 in fra',
    '- Path: through the waiting room, while the server woke',
    '- Wake: start op-1, succeeded',
    '- Sent: 4000 bytes up, 900000 down',
    '',
    '## Timeline (UTC)',
    '',
    '| Time | +s | Where | Event |',
    '|---|---|---|---|',
    '| 15:43:20.000 | -1 | edge | Server list pinged it |',
    '| 15:43:21.000 | 0 | edge | Connected to castle.play.example |',
    '| 15:43:21.200 | 0.2 | edge | Asked the control plane to wake the server |',
    '| 15:43:21.400 | 0.4 | control | start: attempt |',
    '| 15:43:25.000 | 4 | control | start: booting |',
    '| 15:44:01.000 | 40 | edge | Server up |',
    '| 15:44:01.500 | 40.5 | edge | Handed from the waiting room to the server |',
    '| 15:44:02.000 | 41 | server | Logged in |',
    '| 15:45:31.000 | 130 | server | In the world (31.5 ms a tick, 3 online) |',
    '| 15:50:00.000 | 399 | server | Left: disconnected |',
    '',
    '## What looked wrong',
    '',
    '- Slow join: 89 (limit 30)',
    '',
    '## What we don’t know',
    '',
    '- No configuration times: Paper older than 1.21.7 doesn’t report them.',
  ])
})

test('nothing wrong and nothing missing are said in words too', () => {
  const report = joinReport({
    ...VIEW,
    join: { ...JOIN, configureStartedAt: JOIN.loginAt, configuredAt: JOIN.loginAt },
    signals: [],
  })
  expect(report).toContain('Nothing crossed a limit.')
  expect(report).toContain('Nothing: both halves told of every step.')
})

test('a join the server never told of, and the edge never saw, says so', () => {
  const lines = joinReport({
    ...VIEW,
    wake: null,
    join: {
      ...JOIN,
      serverSide: 'not_reported',
      inWorldAt: null,
      pingedAt: null,
      detail: { edge: 'missing' },
    },
  })
  expect(
    lines.filter(
      (line) => line.startsWith('- ') && lines.indexOf(line) > lines.indexOf('## What we don’t know'),
    ),
  ).toEqual([
    '- The edge’s half is missing: no connection the edge reported matched this join.',
    '- The server didn’t report its side: the join reporter isn’t on it (JOIN_REPORTER), it isn’t a Paper server, or it hasn’t fully booted since the reporter was turned on.',
    '- No server-list ping before the join.',
    '- Its wake’s start is no longer kept.',
  ])
})

test('a signal on one line, leaving out the parts its kind doesn’t have', () => {
  expect(signalLine(SLOW)).toBe(
    '#7 15:46 UTC Slow join · Castle · Steve via castle.play.example · 89 (limit 30)',
  )
  expect(
    signalLine({ ...SLOW, id: 8, kind: 'repeated_wakes', detail: { server: 'Castle', figure: 9, limit: 6 } }),
  ).toBe('#8 15:46 UTC Woken again and again · Castle · 9 (limit 6)')
  expect(signalLine({ ...SLOW, id: 9, kind: 'legacy_login_listener', detail: { server: 'Castle' } })).toBe(
    '#9 15:46 UTC Plugin listening at login · Castle',
  )
})

test('a join on one line', () => {
  expect(joinLine(JOIN)).toBe(
    `2026-10-20 15:43:21 ${JOIN.id} Castle · Steve via castle.play.example · held · in the world in 89 s · disconnected`,
  )
})

test('a join the server reported without its login says the login is missing', () => {
  const lines = joinReport({ ...VIEW, join: { ...JOIN, loginAt: null } })
  expect(lines).toContain('- No login time: the server’s word of it didn’t reach this join.')
  expect(lines).not.toContain('Nothing: both halves told of every step.')
})
