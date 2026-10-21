// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins and the signals raised on them, as operators read them under `/ops/v1/joins` and
 * `/ops/v1/signals`: joins narrowed by server, player, address and time; one join with what
 * explains it; the join nearest a moment; the open signals, oldest first; and a signal closed by
 * the operator who looked at it. The records themselves are `app/joins/`'s.
 */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { JoinService } from '../../app/joins/service.ts'
import { OPS_BASE, operatorOf } from './gate.ts'

export interface JoinOptions {
  joins: Pick<JoinService, 'list' | 'detail' | 'find' | 'signals' | 'closeSignal'>
}

const Moment = z.iso.datetime({ offset: true }).transform((at) => new Date(at))
const ListQuery = z.object({
  server: z.string().min(1).optional(),
  player: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  since: Moment.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
const FindQuery = z.object({ player: z.string().min(1), at: Moment.optional() })

export function joinRoutes(app: Hono, { joins }: JoinOptions): void {
  app.get(`${OPS_BASE}/joins`, async (c) =>
    c.json({ joins: await joins.list(ListQuery.parse(c.req.query())) }),
  )
  // Before `:id`, which would take it.
  app.get(`${OPS_BASE}/joins/find`, async (c) => {
    const { player, at } = FindQuery.parse(c.req.query())
    return c.json(await joins.find(player, at))
  })
  app.get(`${OPS_BASE}/joins/:id`, async (c) => c.json(await joins.detail(c.req.param('id'))))
  app.get(`${OPS_BASE}/signals`, async (c) => {
    const since = c.req.query('since')
    return c.json({ signals: await joins.signals(since === undefined ? undefined : Moment.parse(since)) })
  })
  app.post(`${OPS_BASE}/signals/:id/close`, async (c) =>
    c.json(
      await joins.closeSignal(operatorOf(c), z.coerce.number().int().positive().parse(c.req.param('id'))),
    ),
  )
}
