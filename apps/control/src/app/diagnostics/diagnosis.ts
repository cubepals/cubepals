// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Everything the control plane knows about why one account is having a bad time, put together
 * in one answer for an operator or an agent: who it is, its servers, the operations on them that
 * failed or ran slowest, joins that never reached the world, the signals raised on its servers,
 * how its Paper servers ticked, and what ran slow or failed for it, grouped and newest. It reads;
 * it changes nothing.
 *
 * Not for the account's standing, plan or limits in full, which `GET /ops/v1/accounts/<account>`
 * gives, or for one join's story (`join_get`).
 */
import type { AccountDiagnosisView } from '@blockly/contracts/diagnostics'
import type { SignalView } from '@blockly/contracts/join-records'
import type { AccountDetail } from '../accounts/queries.ts'
import type { Actor } from '../actor.ts'
import type { JoinService } from '../joins/service.ts'
import type { PlatformHealth } from '../platform/health.ts'
import type { VitalsService } from '../vitals/service.ts'
import type { DiagnosticsService } from './service.ts'

export interface DiagnosisSources {
  health: Pick<PlatformHealth, 'ofServers'>
  joins: Pick<JoinService, 'list' | 'signals'>
  diagnostics: Pick<DiagnosticsService, 'summary' | 'list'>
  vitals: Pick<VitalsService, 'worst'>
}

/** Joins kept for each server: the latest that stopped short. */
const JOINS_PER_SERVER = 20

export async function diagnoseAccount(
  sources: DiagnosisSources,
  actor: Actor,
  account: Pick<AccountDetail, 'userId' | 'email' | 'name' | 'standing' | 'serverList'>,
  since: Date,
  now = new Date(),
): Promise<AccountDiagnosisView> {
  const servers = account.serverList
  const ids = servers.map((server) => server.id)
  const filter = { accountId: account.userId, since: since.toISOString() }
  const [operations, joins, signals, summary, recent, ticks] = await Promise.all([
    sources.health.ofServers(actor, ids, since, now),
    // Narrowed before the limit, so a busy server's good joins never push its failed ones out.
    Promise.all(
      ids.map((server) => sources.joins.list({ server, since, stoppedShort: true, limit: JOINS_PER_SERVER })),
    ),
    sources.joins.signals(since),
    sources.diagnostics.summary({ ...filter, by: 'name', limit: 15 }, now),
    sources.diagnostics.list({ ...filter, limit: 20 }, now),
    sources.vitals.worst({ since, ownerId: account.userId }),
  ])
  const ours = (signal: SignalView) => signal.serverId !== null && ids.includes(signal.serverId)
  return {
    account: {
      id: account.userId,
      email: account.email,
      name: account.name,
      plan: account.standing.plan,
      status: account.standing.status,
      test: account.standing.testAccount,
    },
    since: since.toISOString(),
    servers,
    operations,
    joins: joins.flat().sort((a, b) => b.connectedAt.localeCompare(a.connectedAt)),
    signals: signals.filter(ours),
    diagnostics: { summary: summary.groups, recent },
    vitals: ticks.servers,
    elsewhere: [
      `Errors the API answered this account with a 5xx are PostHog's $exception events with distinct_id ${account.userId} (production only).`,
      'A server’s own log: console_read with its id; one join’s whole story: join_get.',
      'Platform-wide speed and errors, naming no one: the metrics in docs/metrics.md.',
    ],
  }
}
