// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an owner does on a server's own pages, as operators do it under `/ops/v1/servers/:id`: the
 * console (a command, and the lines it printed lately), the identity settings (name, description,
 * icon or picture, tags and address) and the server list message, the mods page (list, search,
 * plan, add and remove) and the players page (the whitelist, operators, bans and helpers, and the
 * moderation tools). Each route calls the service the web's own route calls, as the operator, so
 * the audit log says `operator:<name>`. The server's life itself (made, started, trashed) is
 * `ops.ts`'s.
 */
import { randomUUID } from 'node:crypto'
import {
  ACCESS_LISTS,
  ApplyModChangeInput,
  BanInput,
  ChangeAddressInput,
  ModChangeInput,
  ModSearchInput,
  SaveIdentityInput,
  ServerSettingsInput,
  SetModerationInput,
  WhitelistModeInput,
} from '@blockly/contracts'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { AccessService } from '../../app/access/service.ts'
import type { OperatorActor } from '../../app/actor.ts'
import type { ConsoleFeed } from '../../app/console/feed.ts'
import type { ConsoleService } from '../../app/console/service.ts'
import { AppError, NotFound } from '../../app/errors.ts'
import type { ModerationService } from '../../app/moderation/service.ts'
import type { ModQueries } from '../../app/mods/queries.ts'
import type { ModService } from '../../app/mods/service.ts'
import type { RevisionService } from '../../app/revisions/service.ts'
import type { ServerQueries } from '../../app/servers/queries.ts'
import type { MinecraftServerService } from '../../app/servers/service.ts'
import { ownIcon } from '../trpc/own-icon.ts'
import { bodyOf, OPS_BASE, operatorOf } from './gate.ts'

export interface ServerPagesOptions {
  console: Pick<ConsoleService, 'run'>
  feed: Pick<ConsoleFeed, 'recent'>
  servers: Pick<MinecraftServerService, 'saveIdentity' | 'changeAddress'>
  revisions: Pick<RevisionService, 'changeSettings'>
  queries: Pick<ServerQueries, 'get' | 'access'>
  mods: Pick<ModService, 'search' | 'plan' | 'apply'>
  modQueries: Pick<ModQueries, 'list' | 'planView'>
  access: Pick<AccessService, 'add' | 'remove' | 'setWhitelistEnabled'>
  moderation: Pick<ModerationService, 'view' | 'setTools'>
}

const CommandBody = z.object({ command: z.string().min(1) })
const LinesQuery = z.coerce.number().int().min(1).max(500).default(100)
const IdentityBody = SaveIdentityInput.omit({ serverId: true })
const AddressBody = ChangeAddressInput.omit({ serverId: true })
const MessageBody = ServerSettingsInput.pick({ motd: true })
const SearchQuery = ModSearchInput.omit({ serverId: true }).extend({
  offset: z.coerce.number().int().min(0).default(0),
})
const ModChangeBody = ModChangeInput.omit({ serverId: true })
/** A change as the mods page applies it; without `expected`, the jars it plans now are the ones meant. */
const ApplyBody = ModChangeBody.extend({
  expected: ApplyModChangeInput.shape.expected.optional(),
  acknowledgeRevoked: z.boolean().optional(),
  requestId: z.uuid().optional(),
})
const WhitelistBody = WhitelistModeInput.omit({ serverId: true })
const List = z.enum(ACCESS_LISTS)
const PlayerBody = BanInput.omit({ serverId: true })
const ModerationBody = SetModerationInput.omit({ serverId: true, requestId: true }).extend({
  requestId: z.uuid().optional(),
})

const SERVER = `${OPS_BASE}/servers/:id` as const

export function serverPageRoutes(app: Hono, options: ServerPagesOptions): void {
  consoleRoutes(app, options)
  identityRoutes(app, options)
  modRoutes(app, options)
  playerRoutes(app, options)
}

function consoleRoutes(app: Hono, { console, feed, queries }: ServerPagesOptions): void {
  app.post(`${SERVER}/console`, async (c) => {
    const { command } = CommandBody.parse(await bodyOf(c))
    return c.json({ output: await console.run(operatorOf(c), c.req.param('id'), command) })
  })
  // The lines the console would show someone who just opened it; a server nobody has is not found.
  app.get(`${SERVER}/console`, async (c) => {
    const { id } = await queries.get(operatorOf(c), c.req.param('id'))
    return c.json({ lines: await feed.recent(id, LinesQuery.parse(c.req.query('lines'))) })
  })
}

function identityRoutes(app: Hono, { servers, revisions, queries }: ServerPagesOptions): void {
  app.patch(`${SERVER}/identity`, async (c) => {
    const operator = operatorOf(c)
    const { picture, ...identity } = IdentityBody.parse(await bodyOf(c))
    // A picture of its own is read as the web's route reads one: drawn again from its pixels.
    const own = picture === undefined || picture === null ? picture : ownIcon(Buffer.from(picture, 'base64'))
    await servers.saveIdentity(operator, c.req.param('id'), { ...identity, picture: own })
    return c.json(await queries.get(operator, c.req.param('id')))
  })
  app.put(`${SERVER}/address`, async (c) => {
    const operator = operatorOf(c)
    const { slug } = AddressBody.parse(await bodyOf(c))
    await servers.changeAddress(operator, c.req.param('id'), slug)
    return c.json(await queries.get(operator, c.req.param('id')))
  })
  // The message under its name in players' server lists: one of its settings, the rest kept as they are.
  app.put(`${SERVER}/message`, async (c) => {
    const operator = operatorOf(c)
    const { motd } = MessageBody.parse(await bodyOf(c))
    const { settings, version } = await queries.get(operator, c.req.param('id'))
    const game = ServerSettingsInput.parse({ ...settings, motd })
    await revisions.changeSettings(operator, c.req.param('id'), game, randomUUID(), { version })
    return c.json(await queries.get(operator, c.req.param('id')))
  })
}

function modRoutes(app: Hono, options: ServerPagesOptions): void {
  app.get(`${SERVER}/mods`, async (c) =>
    c.json(await options.modQueries.list(operatorOf(c), c.req.param('id'))),
  )
  app.get(`${SERVER}/mods/search`, async (c) => {
    const { text, offset } = SearchQuery.parse(c.req.query())
    const found = await options.mods.search(operatorOf(c), c.req.param('id'), { text, offset, limit: 20 })
    return c.json({
      total: found.total,
      hits: found.hits.map(({ projectId, slug, name, summary, downloads, runsOnServers }) => ({
        projectId,
        slug,
        name,
        summary,
        downloads,
        runsOnServers,
      })),
    })
  })
  app.post(`${SERVER}/mods/plan`, async (c) => {
    const change = ModChangeBody.parse(await bodyOf(c))
    return c.json(
      options.modQueries.planView(await options.mods.plan(operatorOf(c), c.req.param('id'), change)),
    )
  })
  app.post(`${SERVER}/mods`, async (c) => {
    const operator = operatorOf(c)
    const { expected, acknowledgeRevoked, requestId, ...change } = ApplyBody.parse(await bodyOf(c))
    const id = c.req.param('id')
    await options.mods.apply(
      operator,
      id,
      change,
      expected ?? (await planned(options, operator, id, change)),
      requestId ?? randomUUID(),
      { acknowledgeRevoked },
    )
    return c.json(await options.queries.get(operator, id))
  })
}

/** The jars a change comes to now, as the mods page shows them before it is applied. */
async function planned(
  { mods, modQueries }: ServerPagesOptions,
  operator: OperatorActor,
  serverId: string,
  change: z.infer<typeof ModChangeBody>,
): Promise<string[]> {
  const plan = modQueries.planView(await mods.plan(operator, serverId, change))
  if (plan.kind === 'ok') return plan.expected
  const moves = plan.movesTo === null ? '' : ` It works on ${plan.movesTo.gameVersion}, with moveTo.`
  throw new AppError(
    'mods_conflict',
    `That change doesn't fit this server: ${plan.conflicts.map((conflict) => conflict.mod).join(', ')}.${moves}`,
  )
}

function playerRoutes(app: Hono, { access, moderation, queries }: ServerPagesOptions): void {
  app.get(`${SERVER}/access`, async (c) => c.json(await queries.access(operatorOf(c), c.req.param('id'))))
  app.put(`${SERVER}/access/whitelist`, async (c) => {
    const operator = operatorOf(c)
    const { enabled } = WhitelistBody.parse(await bodyOf(c))
    await access.setWhitelistEnabled(operator, c.req.param('id'), enabled)
    return c.json(await queries.access(operator, c.req.param('id')))
  })
  app.post(`${SERVER}/access/:list`, async (c) => {
    const operator = operatorOf(c)
    const list = List.parse(c.req.param('list'))
    const { name, reason } = PlayerBody.parse(await bodyOf(c))
    await access.add(operator, c.req.param('id'), list, name, list === 'ban' ? reason : undefined)
    return c.json(await queries.access(operator, c.req.param('id')))
  })
  // A player by their uuid, or by the name the list shows them under.
  app.delete(`${SERVER}/access/:list/:player`, async (c) => {
    const operator = operatorOf(c)
    const list = List.parse(c.req.param('list'))
    const player = c.req.param('player')
    const { entries } = await queries.access(operator, c.req.param('id'))
    const entry = entries.find(
      (e) =>
        e.list === list && (e.player.uuid === player || e.player.name.toLowerCase() === player.toLowerCase()),
    )
    if (entry === undefined) throw new NotFound('Player')
    await access.remove(operator, c.req.param('id'), list, entry.player.uuid)
    return c.json(await queries.access(operator, c.req.param('id')))
  })
  app.get(`${SERVER}/moderation`, async (c) =>
    c.json(await moderation.view(operatorOf(c), c.req.param('id'))),
  )
  app.put(`${SERVER}/moderation`, async (c) => {
    const operator = operatorOf(c)
    const { requestId, ...wanted } = ModerationBody.parse(await bodyOf(c))
    await moderation.setTools(operator, c.req.param('id'), wanted, requestId ?? randomUUID())
    return c.json(await queries.get(operator, c.req.param('id')))
  })
}
