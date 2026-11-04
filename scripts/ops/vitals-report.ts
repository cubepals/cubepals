// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How servers tick, written for a person: the platform now and one line a server for
 * `ops.ts vitals`, the worst first, and one server's minutes for `ops.ts vitals <server>`. What
 * only the reporter plugin sees is left out of a line where only the console was read. Pure: it
 * reads only the views the operators' API answers with.
 */
import type {
  PlatformVitalsView,
  ServerVitalsView,
  VitalsRowView,
  VitalsSampleView,
  VitalsSummaryView,
} from '@blockly/contracts/server-vitals'

const at = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
const share = (n: number) => `${Math.round(n * 100)}%`
/** The parts of a line that were known, joined. */
const known = (parts: Array<string | null>) => parts.filter((part) => part !== null).join(', ')

/** `<running> running · <sampled> sampled (<n> by the plugin, <n> by the console) · …`. */
export function platformLine(p: PlatformVitalsView): string {
  return `${p.running} running · ${p.sampled} sampled (${p.byReporter} by the plugin, ${p.byConsole} by the console) · ${p.laggingNow} behind now · ${p.silent} silent`
}

/** What a while of samples adds up to, in a line. */
function summaryLine(s: VitalsSummaryView): string {
  const behind =
    s.laggingMinutes === 0 ? 'never behind' : `${s.laggingMinutes} of ${s.samples} minutes behind`
  return known([
    behind,
    `tps min ${s.tpsMin} (mean ${s.tpsMean})`,
    `mspt p50 ${s.msptP50} p95 ${s.msptP95} max ${s.msptMax}`,
    s.heapShareMax === null ? null : `heap up to ${share(s.heapShareMax)}`,
    s.gcMsMax === null ? null : `gc up to ${s.gcMsMax} ms a minute`,
    `up to ${s.playersMax} players`,
    s.chunksMax === null ? null : `${s.chunksMax} chunks`,
    s.entitiesMax === null ? null : `${s.entitiesMax} entities`,
    `from the ${s.sources.join(' and the ')}`,
  ])
}

/** `<server> · <owner> · <what its samples add up to> · last <when>`. */
export function vitalsLine(row: VitalsRowView): string {
  return [
    row.serverName,
    row.ownerEmail ?? row.ownerId,
    summaryLine(row),
    `last ${at(row.lastAt)}`,
    row.serverId,
  ].join(' · ')
}

const minuteLine = (s: VitalsSampleView) =>
  [
    `${at(s.at)} tps ${s.tps} mspt ${s.mspt} p95 ${s.msptP95} max ${s.msptMax}`,
    `${s.players} players`,
    s.chunks === null ? null : `${s.chunks} chunks`,
    s.entities === null ? null : `${s.entities} entities`,
    s.heapUsedMb === null ? null : `heap ${s.heapUsedMb}/${s.heapMaxMb} MB`,
    s.gcMs === null ? null : `gc ${s.gcMs} ms`,
    s.source,
  ]
    .filter((part) => part !== null)
    .join(' · ')

/** One server's ticks: what they add up to, then each minute, oldest first. */
export function serverVitalsReport(view: ServerVitalsView): string[] {
  const name = view.serverName ?? view.serverId
  if (view.summary === null) return [`${name}: no tick reported since ${at(view.since)}.`]
  return [
    `${name} since ${at(view.since)}: ${summaryLine(view.summary)}`,
    '',
    ...view.samples.map(minuteLine),
  ]
}
