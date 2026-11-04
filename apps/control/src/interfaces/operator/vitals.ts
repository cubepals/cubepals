// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How Paper servers tick, as operators read it: `/ops/v1/vitals` (the servers that ticked worst
 * since a moment, the most minutes behind first, with whose they are; one account's alone with
 * `account`), and `/ops/v1/servers/<id>/vitals` (one server's samples and what they add up to).
 * They read; nothing here changes anything. The samples are `app/vitals/`'s.
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import { ServerVitalsQuery, VitalsQuery } from '@blockly/contracts/server-vitals'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { AccountDetail } from '../../app/accounts/queries.ts'
import type { OperatorActor } from '../../app/actor.ts'
import type { VitalsService } from '../../app/vitals/service.ts'
import { OPS_BASE, operatorOf } from './gate.ts'

export interface VitalsOptions {
  vitals: Pick<VitalsService, 'ofServer' | 'worst'>
}

/** An hour ago unless `since` says when. */
const sinceOf = (since: string | undefined, now: Date) =>
  since === undefined ? new Date(now.getTime() - HOUR_MS) : new Date(since)

export function vitalsRoutes(
  app: Hono,
  { vitals }: VitalsOptions,
  findAccount: (operator: OperatorActor, ref: string) => Promise<AccountDetail>,
): void {
  app.get(`${OPS_BASE}/vitals`, async (c) => {
    const { account, since, limit } = VitalsQuery.parse(c.req.query())
    const ownerId = account === undefined ? undefined : (await findAccount(operatorOf(c), account)).userId
    return c.json(
      await vitals.worst({
        since: sinceOf(since, new Date()),
        ...(limit === undefined ? {} : { limit }),
        ...(ownerId === undefined ? {} : { ownerId }),
      }),
    )
  })
  app.get(`${OPS_BASE}/servers/:id/vitals`, async (c) => {
    const { since } = ServerVitalsQuery.parse(c.req.query())
    const now = new Date()
    return c.json(await vitals.ofServer(z.uuid().parse(c.req.param('id')), sinceOf(since, now), now))
  })
}
