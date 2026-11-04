// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What ran slow or failed, the database and one account's trouble, written out (`diagnostics-report.ts`). */
import { expect, test } from 'bun:test'
import type { AccountDiagnosisView, DatabaseView, DiagnosticView } from '@blockly/contracts/diagnostics'
import { databaseReport, diagnosisReport, diagnosticLine, summaryReport } from './diagnostics-report.ts'

const SLOW: DiagnosticView = {
  id: 7,
  at: '2026-11-04T12:00:01.250Z',
  kind: 'query',
  name: 'q:0a1b2c3d4e5f',
  ms: 412.3,
  error: '57014',
  origin: 'trpc:servers.get',
  role: 'api',
  accountId: 'acct-1',
  accountEmail: 'owner@example.test',
  serverId: 'server-1',
  serverName: 'Castle',
  requestId: 'req-1',
  detail: { statement: 'select * from "minecraft_servers" where "id" = $n', message: 'canceling statement' },
}

test('a record is one line: when, what, how long, how it ended, and whose', () => {
  expect(diagnosticLine(SLOW)).toBe(
    '2026-11-04 12:00:01 query q:0a1b2c3d4e5f 412 ms failed 57014 · trpc:servers.get · owner@example.test · Castle · request req-1',
  )
  expect(
    diagnosticLine({
      ...SLOW,
      error: null,
      ms: 2500,
      accountEmail: null,
      accountId: null,
      serverId: null,
      serverName: null,
      requestId: null,
    }),
  ).toBe('2026-11-04 12:00:01 query q:0a1b2c3d4e5f 2.5 s · trpc:servers.get')
})

test('groups say how slow, whom they touched, and their slowest in full', () => {
  const lines = summaryReport({
    since: '2026-11-03T12:00:00.000Z',
    until: '2026-11-04T12:00:00.000Z',
    by: 'name',
    total: 3,
    failed: 1,
    thresholds: { queryMs: 250, procedureMs: 1000, requestMs: 2000 },
    groups: [
      {
        key: 'q:0a1b2c3d4e5f',
        label: null,
        count: 3,
        failed: 1,
        accounts: 2,
        servers: 1,
        p50Ms: 300,
        p95Ms: 410,
        maxMs: 412,
        firstAt: '2026-11-04T10:00:00.000Z',
        lastAt: '2026-11-04T12:00:01.250Z',
        slowest: SLOW,
      },
    ],
  })
  expect(lines[0]).toBe('3 slow or failed (1 failed), 2026-11-03 12:00:00 to 2026-11-04 12:00:00, by name')
  expect(lines).toContain(
    '3× q:0a1b2c3d4e5f: p50 300 ms, p95 410 ms, max 412 ms, 1 failed, 2 accounts, 1 servers, last 2026-11-04 12:00:01',
  )
  expect(lines.at(-1)).toBe('  select * from "minecraft_servers" where "id" = $n — canceling statement')
})

test('the database says what holds it, what waits, and why it can’t count statements', () => {
  const database: DatabaseView = {
    at: '2026-11-04T12:00:00.000Z',
    connections: [{ application: 'blockly-api', state: 'idle', count: 4 }],
    max: 60,
    active: [
      {
        pid: 41,
        application: 'blockly-worker',
        state: 'active',
        wait: 'Lock',
        querySeconds: 3.21,
        transactionSeconds: 3.3,
        blockedBy: [40],
        query: 'update "minecraft_servers" set "status" = $n',
      },
    ],
    statements: { available: false, why: 'pg_stat_statements is not installed in this database' },
    tables: [
      {
        name: 'public.joins',
        sizeBytes: 1,
        rows: 10,
        deadRows: 0,
        seqScans: 2,
        seqRows: 20,
        indexScans: 9,
        lastAutovacuum: null,
      },
    ],
  }
  expect(databaseReport(database)).toEqual([
    'Connections: 4 of 60',
    '  4 blockly-api idle',
    '',
    'Running long or waiting:',
    '  pid 41 blockly-worker active 3.2 s, waiting on 40: update "minecraft_servers" set "status" = $n',
    '',
    'Statements: pg_stat_statements is not installed in this database',
    '',
    'Tables read most by sequential scans:',
    '  public.joins: 20 rows by 2 scans, 9 index scans, 10 rows',
  ])
})

test('an account’s trouble reads as an incident report, saying none where there is none', () => {
  const view: AccountDiagnosisView = {
    account: {
      id: 'acct-1',
      email: 'owner@example.test',
      name: 'Owner',
      plan: 'plus',
      status: 'active',
      test: false,
    },
    since: '2026-11-03T12:00:00.000Z',
    servers: [{ id: 'server-1', name: 'Castle', slug: 'castle', status: 'failed', deleted: false }],
    operations: {
      failed: [
        {
          id: 'op-1',
          kind: 'start',
          serverId: 'server-1',
          serverName: 'Castle',
          status: 'failed',
          step: 'booting',
          error: 'The server ran out of memory',
          detail: null,
          createdAt: '2026-11-04T11:00:00.000Z',
          finishedAt: '2026-11-04T11:01:00.000Z',
          seconds: 60,
        },
      ],
      slowest: [],
    },
    joins: [],
    signals: [],
    diagnostics: { summary: [], recent: [SLOW] },
    vitals: [],
    elsewhere: ['Look in PostHog.'],
  }
  const report = diagnosisReport(view)
  expect(report.slice(0, 3)).toEqual([
    '# owner@example.test',
    '',
    'Owner, plus, active · `acct-1` · since 2026-11-03 12:00:00',
  ])
  expect(report).toContain('- Castle (failed) `server-1`')
  expect(report).toContain(
    '- 2026-11-04 11:00:00 start on Castle: failed at booting, 60 s — The server ran out of memory',
  )
  expect(report).toContain('Nothing ran slow or failed for it.')
  expect(report).toContain('None of its servers reported ticks.')
  expect(report).toContain(`- ${diagnosticLine(SLOW)}`)
  expect(report.at(-1)).toBe('- Look in PostHog.')
})
