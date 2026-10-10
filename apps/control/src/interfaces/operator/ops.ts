// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Accounts and their servers, acted on from the command line, on the internal listener with the
 * operator token (docs/production.md): an account found and read, its plan and limits set, and a
 * server made for it, started, stopped, sent to the trash and taken back out, rested in the archive
 * store now, or purged now. `scripts/ops.ts` is its command line, and `scripts/production-check.ts`
 * runs a server's whole life through it. Every route goes through the services the web app's own
 * routes use, as the operator the `x-operator` header names, so the audit log says
 * `operator:<name>`. Where servers run is `runtimes.ts`'s; the fleet's hosts are
 * `infra/fleet/operator-api.ts`'s.
 */
import { randomUUID } from 'node:crypto'
import { CreateServerInput, PartySize } from '@blockly/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AccountDetail, AccountQueries } from '../../app/accounts/queries.ts'
import type { AccountService } from '../../app/accounts/service.ts'
import type { OperatorActor } from '../../app/actor.ts'
import { NotFound } from '../../app/errors.ts'
import type { ServerQueries } from '../../app/servers/queries.ts'
import type { MinecraftServerService } from '../../app/servers/service.ts'
import type { UpkeepNow } from '../../app/servers/upkeep-now.ts'
import { gate, operatorOf } from './gate.ts'

const OPS_BASE = '/ops/v1'

export interface OpsApiOptions {
  accounts: Pick<AccountService, 'setPlan' | 'setLimits'>
  accountQueries: Pick<AccountQueries, 'list' | 'get'>
  servers: Pick<MinecraftServerService, 'createFor' | 'start' | 'stop' | 'deleteServer' | 'undeleteServer'>
  queries: Pick<ServerQueries, 'get'>
  upkeep: Pick<UpkeepNow, 'rest' | 'purge'>
  token: string
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PlanBody = z.object({ plan: z.string().min(1) })
const LimitsBody = z.object({
  maxServers: z.number().int().nullable(),
  maxRunning: z.number().int().nullable(),
  includedUnits: z.number().int().nullable().optional(),
})
/** What the web's create flow asks, for an owner named by email or id: plain survival for five unless told. */
const CreateBody = CreateServerInput.omit({ idempotencyKey: true, partySize: true, replaces: true }).extend({
  owner: z.string().min(1),
  idempotencyKey: z.uuid().optional(),
  partySize: PartySize.default('5'),
})
const RequestBody = z.object({ requestId: z.uuid().optional() })
const ConfirmBody = z.object({ confirmName: z.string().min(1) })

type Context = Parameters<typeof operatorOf>[0] & { req: { json: () => Promise<unknown> } }

/** A request's JSON body; none is an empty one. */
const bodyOf = async (c: Context) => (await c.req.json().catch(() => ({}))) ?? {}

/** An account as an operator reads it: who, standing, plan, limits, servers and what was done to it. */
const accountView = ({ standing, ...account }: AccountDetail) => ({
  ...account,
  status: standing.status,
  reason: standing.reason,
  plan: standing.plan,
  limits: standing.limitOverrides,
  restrictions: standing.restrictions,
})

/** An account by its id, or by its email address exactly. */
async function accountOf(
  queries: OpsApiOptions['accountQueries'],
  operator: OperatorActor,
  ref: string,
): Promise<AccountDetail> {
  if (ACCOUNT_ID.test(ref)) return queries.get(operator, ref)
  const { accounts } = await queries.list(operator, { search: ref, offset: 0, limit: 50 })
  const account = accounts.find((row) => row.email.toLowerCase() === ref.toLowerCase())
  if (account === undefined) throw new NotFound('Account')
  return queries.get(operator, account.userId)
}

export function createOpsApi(options: OpsApiOptions): Hono {
  const app = new Hono()
  gate(app, OPS_BASE, options.token)
  accountRoutes(app, options)
  serverRoutes(app, options)
  return app
}

function accountRoutes(app: Hono, { accounts, accountQueries }: OpsApiOptions): void {
  app.get(`${OPS_BASE}/accounts`, async (c) => {
    const search = c.req.query('search') ?? ''
    const found = await accountQueries.list(operatorOf(c), { search, offset: 0, limit: 50 })
    return c.json({
      total: found.total,
      accounts: found.accounts.map(({ standing, ...row }) => ({
        ...row,
        status: standing.status,
        plan: standing.plan,
      })),
    })
  })
  app.get(`${OPS_BASE}/accounts/:account`, async (c) =>
    c.json(accountView(await accountOf(accountQueries, operatorOf(c), c.req.param('account')))),
  )
  app.put(`${OPS_BASE}/accounts/:account/plan`, async (c) => {
    const operator = operatorOf(c)
    const { plan } = PlanBody.parse(await bodyOf(c))
    const { userId } = await accountOf(accountQueries, operator, c.req.param('account'))
    await accounts.setPlan(operator, userId, plan)
    return c.json(accountView(await accountQueries.get(operator, userId)))
  })
  app.put(`${OPS_BASE}/accounts/:account/limits`, async (c) => {
    const operator = operatorOf(c)
    const limits = LimitsBody.parse(await bodyOf(c))
    const { userId } = await accountOf(accountQueries, operator, c.req.param('account'))
    await accounts.setLimits(operator, userId, limits)
    return c.json(accountView(await accountQueries.get(operator, userId)))
  })
}

function serverRoutes(app: Hono, { accountQueries, servers, queries, upkeep }: OpsApiOptions): void {
  app.post(`${OPS_BASE}/servers`, async (c) => {
    const operator = operatorOf(c)
    const { owner, idempotencyKey, ...request } = CreateBody.parse(await bodyOf(c))
    const { userId } = await accountOf(accountQueries, operator, owner)
    const made = await servers.createFor(operator, userId, {
      ...request,
      idempotencyKey: idempotencyKey ?? randomUUID(),
    })
    return c.json(await queries.get(operator, made.id), 201)
  })
  app.get(`${OPS_BASE}/servers/:id`, async (c) => c.json(await queries.get(operatorOf(c), c.req.param('id'))))
  app.post(`${OPS_BASE}/servers/:id/start`, async (c) => {
    const operator = operatorOf(c)
    const { requestId } = RequestBody.parse(await bodyOf(c))
    await servers.start(operator, c.req.param('id'), requestId ?? randomUUID())
    return c.json(await queries.get(operator, c.req.param('id')))
  })
  app.post(`${OPS_BASE}/servers/:id/stop`, async (c) => {
    const operator = operatorOf(c)
    const { requestId } = RequestBody.parse(await bodyOf(c))
    await servers.stop(operator, c.req.param('id'), requestId ?? randomUUID())
    return c.json(await queries.get(operator, c.req.param('id')))
  })
  app.post(`${OPS_BASE}/servers/:id/trash`, async (c) => {
    const operator = operatorOf(c)
    const { confirmName } = ConfirmBody.parse(await bodyOf(c))
    await servers.deleteServer(operator, c.req.param('id'), confirmName)
    return c.json(await queries.get(operator, c.req.param('id')))
  })
  app.post(`${OPS_BASE}/servers/:id/untrash`, async (c) => {
    const operator = operatorOf(c)
    await servers.undeleteServer(operator, c.req.param('id'))
    return c.json(await queries.get(operator, c.req.param('id')))
  })
  // Resting and purging are queued: the answer is the server as it is when the work is asked for.
  app.post(`${OPS_BASE}/servers/:id/rest`, async (c) => {
    const operator = operatorOf(c)
    const { requestId } = RequestBody.parse(await bodyOf(c))
    await upkeep.rest(operator, c.req.param('id'), requestId ?? randomUUID())
    return c.json(await queries.get(operator, c.req.param('id')), 202)
  })
  app.post(`${OPS_BASE}/servers/:id/purge`, async (c) => {
    const operator = operatorOf(c)
    const { confirmName } = ConfirmBody.parse(await bodyOf(c))
    await upkeep.purge(operator, c.req.param('id'), confirmName)
    return c.json(await queries.get(operator, c.req.param('id')), 202)
  })
}
