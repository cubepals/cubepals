// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What ran slow or failed, the database now, and one account's trouble, written for a person:
 * the one-line forms `ops.ts diagnostics` prints, the groups `diagnostics summary` prints, the
 * database `ops.ts database` prints, and the report `ops.ts diagnose` prints, meant to be pasted
 * into an incident as it is. Pure: it reads only the views the operators' API answers with.
 */
import type { HealthOperationView } from '@blockly/contracts'
import type {
  AccountDiagnosisView,
  DatabaseView,
  DiagnosticGroupView,
  DiagnosticsSummaryView,
  DiagnosticView,
} from '@blockly/contracts/diagnostics'
import { joinLine, signalLine } from './join-report.ts'

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`)
const at = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
const one = (text: unknown, most = 160) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, most)

/** `<when> <kind> <name> <how long> [<error>] · <origin> · <whose> · <server> · <request>`. */
export function diagnosticLine(d: DiagnosticView): string {
  const whose = d.accountEmail ?? d.accountId
  return [
    `${at(d.at)} ${d.kind} ${d.name} ${ms(d.ms)}${d.error === null ? '' : ` failed ${d.error}`}`,
    d.origin,
    whose,
    d.serverName ?? d.serverId,
    d.requestId === null ? null : `request ${d.requestId}`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** What a record was, in full: a query's statement, an error's message. */
function what(d: DiagnosticView): string | null {
  const said = [d.detail.statement, d.detail.message].filter((part) => typeof part === 'string')
  return said.length === 0 ? null : said.map((part) => one(part, 400)).join(' — ')
}

/** `<count>× <key> [<label>] p50 · p95 · max, <failed> failed, <accounts> accounts, <servers> servers`. */
function groupLine(group: DiagnosticGroupView): string {
  const label = group.label === null ? '' : ` (${group.label})`
  const failed = group.failed === 0 ? '' : `, ${group.failed} failed`
  return `${group.count}× ${group.key}${label}: p50 ${ms(group.p50Ms)}, p95 ${ms(group.p95Ms)}, max ${ms(group.maxMs)}${failed}, ${group.accounts} accounts, ${group.servers} servers, last ${at(group.lastAt)}`
}

export function summaryReport(summary: DiagnosticsSummaryView): string[] {
  const { queryMs, procedureMs, requestMs } = summary.thresholds
  const lines = [
    `${summary.total} slow or failed (${summary.failed} failed), ${at(summary.since)} to ${at(summary.until)}, by ${summary.by}`,
    `Slow is a query past ${ms(queryMs)}, a procedure past ${ms(procedureMs)}, a request past ${ms(requestMs)}.`,
  ]
  for (const group of summary.groups) {
    lines.push('', groupLine(group), `  slowest: ${diagnosticLine(group.slowest)}`)
    const said = what(group.slowest)
    if (said !== null) lines.push(`  ${said}`)
  }
  return lines
}

export function databaseReport(database: DatabaseView): string[] {
  const held = database.connections.reduce((n, c) => n + c.count, 0)
  const lines = [`Connections: ${held} of ${database.max}`]
  for (const c of database.connections) lines.push(`  ${c.count} ${c.application} ${c.state}`)
  lines.push('', database.active.length === 0 ? 'Nothing runs long or waits.' : 'Running long or waiting:')
  for (const a of database.active) {
    const blocked = a.blockedBy.length === 0 ? '' : `, waiting on ${a.blockedBy.join(', ')}`
    lines.push(
      `  pid ${a.pid} ${a.application} ${a.state} ${a.querySeconds.toFixed(1)} s${blocked}: ${one(a.query)}`,
    )
  }
  lines.push('')
  if (!database.statements.available) lines.push(`Statements: ${database.statements.why}`)
  else {
    lines.push(`Statements since ${database.statements.since ?? 'their statistics were reset'}:`)
    for (const s of database.statements.top)
      lines.push(
        `  ${ms(s.totalMs)} in all, ${s.calls} calls, mean ${ms(s.meanMs)}, max ${ms(s.maxMs)} (${s.role}): ${one(s.query)}`,
      )
  }
  lines.push('', 'Tables read most by sequential scans:')
  for (const t of database.tables)
    lines.push(
      `  ${t.name}: ${t.seqRows} rows by ${t.seqScans} scans, ${t.indexScans} index scans, ${t.rows} rows`,
    )
  return lines
}

const operationLine = (op: HealthOperationView) =>
  `${at(op.createdAt)} ${op.kind} on ${op.serverName}: ${op.status}${op.step === null ? '' : ` at ${op.step}`}, ${op.seconds} s${op.error === null ? '' : ` — ${one(op.error)}`}`

/** One account's trouble as an incident report, in Markdown. */
export function diagnosisReport(view: AccountDiagnosisView): string[] {
  const { account } = view
  const section = (title: string, rows: string[], none: string) => [
    '',
    `## ${title}`,
    '',
    ...(rows.length === 0 ? [none] : rows.map((row) => `- ${row}`)),
  ]
  return [
    `# ${account.email}`,
    '',
    `${account.name}, ${account.plan}, ${account.status}${account.test ? ', a test account' : ''} · \`${account.id}\` · since ${at(view.since)}`,
    ...section(
      'Servers',
      view.servers.map((s) => `${s.name} (${s.status}${s.deleted ? ', in the trash' : ''}) \`${s.id}\``),
      'None.',
    ),
    ...section('Operations that failed', view.operations.failed.map(operationLine), 'None.'),
    ...section('Slowest to succeed', view.operations.slowest.map(operationLine), 'None.'),
    ...section('Joins that stopped short', view.joins.map(joinLine), 'None.'),
    ...section('Signals', view.signals.map(signalLine), 'None.'),
    ...section(
      'Slow or failed, by what',
      view.diagnostics.summary.map(groupLine),
      'Nothing ran slow or failed for it.',
    ),
    ...section('Slow or failed, newest', view.diagnostics.recent.map(diagnosticLine), 'None.'),
    ...section('Elsewhere', view.elsewhere, 'Nothing.'),
  ]
}
