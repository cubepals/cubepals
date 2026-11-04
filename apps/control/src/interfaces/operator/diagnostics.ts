// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What ran slow or failed and whose it was, and the database now, as operators read them:
 * `/ops/v1/diagnostics` (the records, narrowed by account, server, what and when),
 * `/ops/v1/diagnostics/summary` (grouped by what, whose, which server or what it ran under),
 * `/ops/v1/database` (what runs, waits and took the most time, as Postgres says), and
 * `/ops/v1/accounts/<account>/diagnosis` (everything known about one account's trouble). They read;
 * nothing here changes anything. The records are `app/diagnostics/`'s.
 */
import { DatabaseQuery, DiagnosticsQuery, DiagnosticsSummaryQuery } from '@blockly/contracts/diagnostics'
import { DAY_MS } from '@blockly/contracts/durations'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { AccountDetail } from '../../app/accounts/queries.ts'
import type { OperatorActor } from '../../app/actor.ts'
import { type DiagnosisSources, diagnoseAccount } from '../../app/diagnostics/diagnosis.ts'
import type { DiagnosticsFilter, DiagnosticsService } from '../../app/diagnostics/service.ts'
import { OPS_BASE, operatorOf } from './gate.ts'

export interface DiagnosticsOptions {
  diagnostics: DiagnosisSources['diagnostics'] & Pick<DiagnosticsService, 'database'>
  health: DiagnosisSources['health']
  joins: DiagnosisSources['joins']
}

/** An account by its id or email, as `ops.ts` finds one. */
export type FindAccount = (operator: OperatorActor, ref: string) => Promise<AccountDetail>

const SinceQuery = z.object({ since: z.iso.datetime({ offset: true }).optional() })

export function diagnosticsRoutes(app: Hono, options: DiagnosticsOptions, findAccount: FindAccount): void {
  /** The query's filter, its account (an id or an email) resolved to the account's id. */
  const filterOf = async <Q extends { account?: string | undefined }>(
    operator: OperatorActor,
    { account, ...query }: Q,
  ): Promise<Omit<Q, 'account'> & DiagnosticsFilter> => ({
    ...query,
    ...(account === undefined ? {} : { accountId: (await findAccount(operator, account)).userId }),
  })

  app.get(`${OPS_BASE}/diagnostics`, async (c) => {
    const filter = await filterOf(operatorOf(c), DiagnosticsQuery.parse(c.req.query()))
    return c.json({ diagnostics: await options.diagnostics.list(filter) })
  })
  app.get(`${OPS_BASE}/diagnostics/summary`, async (c) =>
    c.json(
      await options.diagnostics.summary(
        await filterOf(operatorOf(c), DiagnosticsSummaryQuery.parse(c.req.query())),
      ),
    ),
  )
  app.get(`${OPS_BASE}/database`, async (c) =>
    c.json(await options.diagnostics.database(DatabaseQuery.parse(c.req.query()))),
  )
  app.get(`${OPS_BASE}/accounts/:account/diagnosis`, async (c) => {
    const operator = operatorOf(c)
    const { since } = SinceQuery.parse(c.req.query())
    const now = new Date()
    const account = await findAccount(operator, c.req.param('account'))
    const from = since === undefined ? new Date(now.getTime() - DAY_MS) : new Date(since)
    return c.json(await diagnoseAccount(options, operator, account, from, now))
  })
}
