// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** How servers tick, written out (`vitals-report.ts`). */
import { expect, test } from 'bun:test'
import type { VitalsSampleView, VitalsSummaryView } from '@blockly/contracts/server-vitals'
import { platformLine, serverVitalsReport, vitalsLine } from './vitals-report.ts'

const SUMMARY: VitalsSummaryView = {
  samples: 60,
  firstAt: '2026-11-04T11:00:00.000Z',
  lastAt: '2026-11-04T11:59:00.000Z',
  tpsMin: 11.5,
  tpsMean: 18.9,
  msptP50: 38,
  msptP95: 95.5,
  msptMax: 410,
  laggingMinutes: 7,
  heapShareMax: 0.912,
  gcMsMax: 850,
  playersMax: 9,
  chunksMax: 4100,
  entitiesMax: 2200,
  sources: ['reporter'],
}
const MINUTE: VitalsSampleView = {
  at: '2026-11-04T11:59:00.000Z',
  source: 'reporter',
  tps: 19.2,
  mspt: 30.1,
  msptP95: 52,
  msptMax: 88,
  players: 6,
  chunks: 3900,
  entities: 2100,
  heapUsedMb: 2700,
  heapMaxMb: 3072,
  gcMs: 120,
}

test('a server is one line: whose, how far behind, how slow, and how full', () => {
  expect(
    vitalsLine({
      ...SUMMARY,
      serverId: 'server-1',
      serverName: 'Castle',
      ownerId: 'acct-1',
      ownerEmail: 'owner@example.test',
    }),
  ).toBe(
    'Castle · owner@example.test · 7 of 60 minutes behind, tps min 11.5 (mean 18.9), mspt p50 38 p95 95.5 max 410, heap up to 91%, gc up to 850 ms a minute, up to 9 players, 4100 chunks, 2200 entities, from the reporter · last 2026-11-04 11:59:00 · server-1',
  )
})

test('a server only its console was read on leaves out what only the plugin sees', () => {
  const consoleOnly = {
    ...SUMMARY,
    heapShareMax: null,
    gcMsMax: null,
    chunksMax: null,
    entitiesMax: null,
    sources: ['console' as const],
  }
  expect(
    vitalsLine({ ...consoleOnly, serverId: 's', serverName: 'Farm', ownerId: 'a', ownerEmail: null }),
  ).toBe(
    'Farm · a · 7 of 60 minutes behind, tps min 11.5 (mean 18.9), mspt p50 38 p95 95.5 max 410, up to 9 players, from the console · last 2026-11-04 11:59:00 · s',
  )
  const minute = {
    ...MINUTE,
    source: 'console' as const,
    chunks: null,
    entities: null,
    heapUsedMb: null,
    heapMaxMb: null,
    gcMs: null,
  }
  expect(
    serverVitalsReport({
      serverId: 's',
      serverName: 'Farm',
      since: MINUTE.at,
      latest: minute,
      summary: consoleOnly,
      samples: [minute],
    }).at(-1),
  ).toBe('2026-11-04 11:59:00 tps 19.2 mspt 30.1 p95 52 max 88 · 6 players · console')
})

test('the platform now is one line', () => {
  expect(
    platformLine({
      at: MINUTE.at,
      running: 40,
      sampled: 37,
      byReporter: 12,
      byConsole: 25,
      laggingNow: 3,
      silent: 3,
    }),
  ).toBe('40 running · 37 sampled (12 by the plugin, 25 by the console) · 3 behind now · 3 silent')
})

test('one server reads what its minutes add up to, then each minute, or that none came', () => {
  const view = { serverId: 'server-1', serverName: 'Castle', since: '2026-11-04T11:00:00.000Z' }
  expect(
    serverVitalsReport({
      ...view,
      latest: MINUTE,
      summary: { ...SUMMARY, laggingMinutes: 0 },
      samples: [MINUTE],
    }),
  ).toEqual([
    'Castle since 2026-11-04 11:00:00: never behind, tps min 11.5 (mean 18.9), mspt p50 38 p95 95.5 max 410, heap up to 91%, gc up to 850 ms a minute, up to 9 players, 4100 chunks, 2200 entities, from the reporter',
    '',
    '2026-11-04 11:59:00 tps 19.2 mspt 30.1 p95 52 max 88 · 6 players · 3900 chunks · 2100 entities · heap 2700/3072 MB · gc 120 ms · reporter',
  ])
  expect(serverVitalsReport({ ...view, latest: null, summary: null, samples: [] })).toEqual([
    'Castle: no tick reported since 2026-11-04 11:00:00.',
  ])
})
