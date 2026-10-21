// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Accounts and their servers, acted on from the command line, on the internal listener with the
 * operator token (docs/production.md): an account found, read, or made for a person, its plan and
 * limits set, and a server made for it, started, stopped, tried again after a start that failed
 * (as its owner's Try again does), sent to the trash and taken back out, rested in the archive
 * store now, or purged now. What an owner does on a server's own pages is
 * `server-pages.ts`'s; Browse and its allowlist are `listings.ts`'s; the admins' platform switches
 * are `platform.ts`'s; uploaded jars' malware checks are `jar-checks.ts`'s; joins and their signals are `joins.ts`'s. All of it is under `/ops/v1`. `scripts/ops.ts` is its command line, and `scripts/production-check.ts`
 * runs a server's whole life through it. Production's health reads as the admin Health page
 * reads it (`app/platform/health.ts`): `/health`, `/operations` and one operation's steps. Every
 * route goes through the services the web app's own routes use, as the operator the `x-operator`
 * header names, so the audit log says `operator:<name>`. Where servers run is `runtimes.ts`'s; the fleet's hosts are
 * `infra/fleet/operator-api.ts`'s.
 */
import { randomUUID } from 'node:crypto'
import {
  CreateServerInput,
  CreateTestAccountInput,
  HealthOperationsInput,
  PartySize,
} from '@blockly/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AccountDetail, AccountQueries } from '../../app/accounts/queries.ts'
import type { AccountService } from '../../app/accounts/service.ts'
import type { OperatorActor } from '../../app/actor.ts'
import { AppError, NotFound } from '../../app/errors.ts'
import type { PlatformHealth } from '../../app/platform/health.ts'
import type { ServerQueries } from '../../app/servers/queries.ts'
import type { MinecraftServerService } from '../../app/servers/service.ts'
import type { UpkeepNow } from '../../app/servers/upkeep-now.ts'
import { bodyOf, gate, OPS_BASE, operatorOf } from './gate.ts'
import { type JarCheckOptions, jarCheckRoutes } from './jar-checks.ts'
import { type JoinOptions, joinRoutes } from './joins.ts'
import { type ListingsOptions, listingRoutes } from './listings.ts'
import { type PlatformOptions, platformRoutes } from './platform.ts'
import { type ServerPagesOptions, serverPageRoutes } from './server-pages.ts'

export type OpsApiOptions = ServerPagesOptions &
  ListingsOptions &
  JarCheckOptions &
  JoinOptions &
  PlatformOptions & {
    accounts: Pick<AccountService, 'setPlan' | 'setLimits' | 'createAccount'>
    accountQueries: Pick<AccountQueries, 'list' | 'get'>
    servers: Pick<
      MinecraftServerService,
      'createFor' | 'start' | 'stop' | 'retry' | 'deleteServer' | 'undeleteServer'
    >
    queries: Pick<ServerQueries, 'get'>
    upkeep: Pick<UpkeepNow, 'rest' | 'purge'>
    health: Pick<PlatformHealth, 'view' | 'operations' | 'operation'>
    token: string
  }

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PlanBody = z.object({ plan: z.string().min(1) })
/** A person's address, and what to call them; named after the address unless told. */
const AccountBody = CreateTestAccountInput.pick({ email: true }).extend({
  name: z.string().trim().min(1).max(100).optional(),
})
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
  serverPageRoutes(app, options)
  listingRoutes(app, options)
  platformRoutes(app, options)
  jarCheckRoutes(app, options)
  joinRoutes(app, options)
  healthRoutes(app, options)
  return app
}

/** `?kind=wake&since=<ISO>&slow=<seconds>&status=failed&limit=n`, as `HealthOperationsInput`. */
const OperationsQuery = HealthOperationsInput.extend({
  slowerThan: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

function healthRoutes(app: Hono, { health }: OpsApiOptions): void {
  app.get(`${OPS_BASE}/health`, async (c) => c.json(await health.view(operatorOf(c))))
  app.get(`${OPS_BASE}/operations`, async (c) => {
    const { slow, ...query } = c.req.query()
    const input = OperationsQuery.parse({ ...query, ...(slow === undefined ? {} : { slowerThan: slow }) })
    return c.json({ operations: await health.operations(operatorOf(c), input) })
  })
  app.get(`${OPS_BASE}/operations/:id`, async (c) =>
    c.json(await health.operation(operatorOf(c), z.uuid().parse(c.req.param('id')))),
  )
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
  // An account with no password, for a person who signs in to it with the email link or Google.
  app.post(`${OPS_BASE}/accounts`, async (c) => {
    const operator = operatorOf(c)
    const { email, name } = AccountBody.parse(await bodyOf(c))
    const { userId } = await accounts.createAccount(operator, email, name)
    return c.json(accountView(await accountQueries.get(operator, userId)), 201)
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

/** A start a failed server refuses, saying what does bring it back. */
const RETRY_INSTEAD = new AppError(
  'invalid_transition',
  "It didn't start last time: try it again with retry (`ops.ts retry <server>`), as its owner's Try again does.",
)

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
    await servers.start(operator, c.req.param('id'), requestId ?? randomUUID()).catch(async (error) => {
      throw (await failedLastTime(error)) ? RETRY_INSTEAD : error
    })
    return c.json(await queries.get(operator, c.req.param('id')))

    async function failedLastTime(error: unknown) {
      if (!(error instanceof AppError) || error.code !== 'invalid_transition') return false
      return (await queries.get(operator, c.req.param('id'))).status === 'failed'
    }
  })
  // What a failed server's owner gets from Try again: the failed work again, with what it was asked for.
  app.post(`${OPS_BASE}/servers/:id/retry`, async (c) => {
    const operator = operatorOf(c)
    const { requestId } = RequestBody.parse(await bodyOf(c))
    await servers.retry(operator, c.req.param('id'), requestId ?? randomUUID())
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
