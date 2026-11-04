// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How Paper servers tick, written for a person: one line a server for `ops.ts vitals`, the worst
 * first, and one server's minutes for `ops.ts vitals <server>`. Pure: it reads only the views the
 * operators' API answers with.
 */
import type {
  ServerVitals,
  ServerVitalsView,
  VitalsRowView,
  VitalsSummaryView,
} from '@blockly/contracts/server-vitals'

const at = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
const share = (n: number) => `${Math.round(n * 100)}%`

/** What a while of samples adds up to, in a line. */
function summaryLine(s: VitalsSummaryView): string {
  const behind =
    s.laggingMinutes === 0 ? 'never behind' : `${s.laggingMinutes} of ${s.samples} minutes behind`
  return `${behind}, tps min ${s.tpsMin} (mean ${s.tpsMean}), mspt p50 ${s.msptP50} p95 ${s.msptP95} max ${s.msptMax}, heap up to ${share(s.heapShareMax)}, gc up to ${s.gcMsMax} ms a minute, up to ${s.playersMax} players, ${s.chunksMax} chunks, ${s.entitiesMax} entities`
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

const minuteLine = (s: ServerVitals) =>
  `${at(s.at)} tps ${s.tps} mspt ${s.mspt} p95 ${s.msptP95} max ${s.msptMax} · ${s.players} players · ${s.chunks} chunks · ${s.entities} entities · heap ${s.heapUsedMb}/${s.heapMaxMb} MB · gc ${s.gcMs} ms`

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
