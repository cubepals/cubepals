import { Hono } from 'hono'
import { z } from 'zod'
import { requestedBy } from '../../app/actor.ts'
import { AppError } from '../../app/errors.ts'
import type { RuntimeEconomics } from '../../app/runtimes/economics.ts'
import type { RuntimePlacement } from '../../app/runtimes/service.ts'
import { gate, operatorOf } from './gate.ts'

/**
 * Where servers run, as operators steer it (docs/runtimes.md), on the internal listener with the
 * operator token: the placement rules new servers go by, where a server is and why, a move to
 * another runtime, and what each runtime costs against what its servers bring in.
 * `scripts/runtimes.ts` is its command line. Owners never see any of it.
 */

export const RUNTIMES_BASE = '/runtimes/v1'

export interface RuntimesApiOptions {
  placement: RuntimePlacement
  economics: RuntimeEconomics
  token: string
}

const List = z.array(z.string().min(1)).max(500)
const RuleBody = z.object({
  provider: z.string().min(1),
  percent: z.number().int(),
  accounts: List.optional(),
  regions: List.optional(),
  plans: List.optional(),
  note: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
})
const RulePatch = RuleBody.omit({ provider: true }).partial()
const MoveBody = z.object({ to: z.string().min(1) })

export function createRuntimesApi(options: RuntimesApiOptions): Hono {
  const { placement, economics } = options
  const app = new Hono()
  const by = (c: Parameters<typeof operatorOf>[0]) => requestedBy(operatorOf(c))
  gate(app, RUNTIMES_BASE, options.token)

  app.get(`${RUNTIMES_BASE}/summary`, async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 90)
    return c.json(await placement.summary(new Date(Date.now() - days * 86_400_000)))
  })
  app.get(`${RUNTIMES_BASE}/rules`, async (c) => c.json({ rules: await placement.rules() }))
  app.post(`${RUNTIMES_BASE}/rules`, async (c) => {
    const body = RuleBody.parse(await c.req.json())
    return c.json({ rule: await placement.addRule(body, by(c)) }, 201)
  })
  app.patch(`${RUNTIMES_BASE}/rules/:id`, async (c) => {
    const body = RulePatch.parse(await c.req.json())
    return c.json({ rule: await placement.changeRule(c.req.param('id'), body, by(c)) })
  })
  app.get(`${RUNTIMES_BASE}/servers/:id`, async (c) => c.json(await placement.where(c.req.param('id'))))
  app.post(`${RUNTIMES_BASE}/servers/:id/move`, async (c) => {
    const { to } = MoveBody.parse(await c.req.json())
    await placement.requestMove(c.req.param('id'), to, by(c))
    return c.json(await placement.where(c.req.param('id')), 202)
  })
  app.delete(`${RUNTIMES_BASE}/servers/:id/move`, async (c) => {
    await placement.cancelMove(c.req.param('id'), by(c))
    return c.json(await placement.where(c.req.param('id')))
  })
  app.get(`${RUNTIMES_BASE}/economics`, async (c) => {
    const now = new Date()
    const to = c.req.query('to') ? new Date(c.req.query('to') ?? '') : now
    const from = c.req.query('from')
      ? new Date(c.req.query('from') ?? '')
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1))
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to)
      throw new AppError('invalid_choice', 'from and to are dates, from before to.')
    return c.json(await economics.report({ from, to }))
  })
  return app
}
