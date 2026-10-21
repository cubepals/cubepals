// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operators' API as an MCP server over stdio, for an agent to run the platform with
 * (docs/production.md § From the command line):
 *
 *   bun scripts/ops-mcp.ts [--production]
 *
 * One tool for each `scripts/ops.ts` command: accounts, a server's life, its console, identity,
 * mods and players pages, Browse and its allowlist, the platform switches, uploaded jars' malware
 * checks, joins and their signals, and production's health.
 * Each calls the same `/ops/v1` route the command does, and answers with the API's JSON. Tools that
 * can't be undone, or take something away from a player, say so first in their description, and
 * take a `confirm` that names what they act on again (`lib/operator-inputs.ts`): nothing is called
 * until it matches. Every input is checked against its schema before any call.
 *
 * It speaks over stdio only, and opens no port. It reaches the API as `ops.ts` does: OPERATOR_API
 * and OPERATOR_TOKEN, or with --production through `fly proxy` with production's own values
 * (scripts/lib/production-reach.ts), and won't start without them; there is no default token.
 * OPERATOR (or USER) is who the audit log says acted, `operator:mcp` when neither is set. Stdout
 * carries the protocol and nothing else; no secret is printed, or answered with in a tool's result
 * or error (`withoutSecrets`).
 */
import { join } from 'node:path'
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { operatorCli, withoutSecrets } from './lib/operator-cli.ts'
import { ConsoleCommand, Line, namesServer, PLATFORM } from './lib/operator-inputs.ts'
import { reachProduction } from './lib/production-reach.ts'

const { api } = operatorCli('ops-mcp', '/ops/v1', 'docs/production.md', 'throw', 'mcp')

// An MCP client starts it wherever it likes; production's values are found from the repository's root.
process.chdir(join(import.meta.dir, '..'))

if (process.argv.includes('--production'))
  await reachProduction().catch((error: Error) => {
    console.error(`ops-mcp: ${error.message}`)
    process.exit(1)
  })
if (!process.env.OPERATOR_API || !process.env.OPERATOR_TOKEN) {
  console.error('ops-mcp: set OPERATOR_API and OPERATOR_TOKEN, or pass --production (docs/production.md)')
  process.exit(1)
}

const server = new McpServer({ name: 'cubepals-ops', version: '1.0.0' })

const NOT_UNDONE = 'Destructive: '
const account = Line.min(1).describe('The account’s email address, or its id')
const serverId = z.uuid().describe('The server’s id')
const player = Line.min(1).describe('A Minecraft name, or the player’s uuid as the players list shows it')
const confirmName = Line.describe('The server’s name exactly, as server_get gives it, to confirm')

/** Throws, so nothing is called, unless `confirm` is the server's name. */
async function confirmServer(id: string, confirm: string): Promise<void> {
  if (!(await namesServer(api, id, confirm)))
    throw new Error('Not done: confirm is not the server’s name. Read it with server_get.')
}
const at = (id: string, path = '') => `/servers/${encodeURIComponent(id)}${path}`
const query = (values: Record<string, string | number | undefined>) => {
  const given = Object.entries(values).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined,
  )
  return given.length === 0
    ? ''
    : `?${new URLSearchParams(given.map(([k, v]): [string, string] => [k, String(v)]))}`
}

type Call = Parameters<typeof api>
type Shape = z.ZodRawShape

/** A tool that makes one call to the operators' API and answers with what it said. */
function tool<S extends Shape>(
  name: string,
  description: string,
  input: S,
  request: (args: z.infer<z.ZodObject<S>>) => Call | Promise<Call>,
  hints: { readOnly?: boolean; destructive?: boolean } = {},
) {
  const run = async (args: z.infer<z.ZodObject<S>>) => {
    try {
      const answer = await api(...(await request(args)))
      return { content: [{ type: 'text' as const, text: withoutSecrets(JSON.stringify(answer, null, 2)) }] }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: withoutSecrets((error as Error).message) }],
      }
    }
  }
  server.registerTool(
    name,
    {
      description,
      inputSchema: input,
      annotations: {
        readOnlyHint: hints.readOnly ?? false,
        destructiveHint: hints.destructive ?? false,
        openWorldHint: false,
      },
    },
    // The SDK works its arguments' type out from the shape, which a generic shape leaves open.
    run as unknown as ToolCallback<S>,
  )
}
const read = { readOnly: true }
const gone = { destructive: true }

// ─── Accounts ───────────────────────────────────────────────────────────────────────────────────

tool(
  'accounts_search',
  'Accounts whose email or name holds the search, up to 50.',
  { search: Line.optional() },
  ({ search }) => ['GET', `/accounts${query({ search })}`],
  read,
)
tool(
  'account_get',
  'One account: standing, plan, limits, servers and what was done to it.',
  { account },
  (a) => ['GET', `/accounts/${encodeURIComponent(a.account)}`],
  read,
)
tool(
  'account_create',
  `${NOT_UNDONE}makes an account that can't be taken back, with no password, for a person who signs in to it with the email link or Google. Refused for an address that has an account. Nothing is sent until they sign in. Only when a person asks for it.`,
  {
    email: z.email(),
    name: Line.optional().describe('What to call them; their address’s name if left out'),
    confirm: Line.describe('The same address again, to confirm'),
  },
  ({ email, name, confirm }) => {
    if (confirm !== email) throw new Error('Not done: confirm is not the same address.')
    return ['POST', '/accounts', { email, ...(name ? { name } : {}) }]
  },
  gone,
)
tool(
  'account_set_plan',
  'Comps an account onto a plan without payment, or back to Free.',
  { account, plan: Line.describe('plus or free') },
  (a) => ['PUT', `/accounts/${encodeURIComponent(a.account)}/plan`, { plan: a.plan }],
)
tool(
  'account_set_limits',
  'An account’s own limits over its plan’s. Each left out keeps what it is; null gives back the plan’s own.',
  {
    account,
    maxServers: z.number().int().nullable().optional(),
    maxRunning: z.number().int().nullable().optional(),
    includedHours: z.number().int().nullable().optional(),
  },
  async ({ account: ref, maxServers, maxRunning, includedHours }) => {
    const path = `/accounts/${encodeURIComponent(ref)}`
    const { limits } = (await api('GET', path)) as {
      limits: { maxServers?: number; maxRunning?: number; includedUnits?: number }
    }
    return [
      'PUT',
      `${path}/limits`,
      {
        maxServers: maxServers === undefined ? (limits.maxServers ?? null) : maxServers,
        maxRunning: maxRunning === undefined ? (limits.maxRunning ?? null) : maxRunning,
        includedUnits: includedHours === undefined ? (limits.includedUnits ?? null) : includedHours,
      },
    ]
  },
)

// ─── A server's life ────────────────────────────────────────────────────────────────────────────

tool(
  'server_create',
  'Makes a server for an account, as the website does: plain survival for five unless told.',
  {
    owner: account,
    name: Line.min(1),
    playStyle: z.enum(['survival', 'creative']).optional(),
    template: Line.optional().describe('A template’s key, to make it from'),
    partySize: z.enum(['5', '10', '20', 'more']).optional(),
    regionKey: Line.optional(),
  },
  ({ template, ...made }) => [
    'POST',
    '/servers',
    { ...made, ...(template ? { from: { kind: 'template', key: template } } : {}) },
  ],
)
tool(
  'server_get',
  'One server, as its owner’s page reads it.',
  { serverId },
  (a) => ['GET', at(a.serverId)],
  read,
)
tool('server_start', 'Starts a server.', { serverId }, (a) => ['POST', at(a.serverId, '/start')])
tool(
  'server_retry',
  'Tries again a server that didn’t start last time, as its owner’s Try again does; server_start refuses it.',
  { serverId },
  (a) => ['POST', at(a.serverId, '/retry')],
)
tool('server_stop', 'Stops a server; its world is kept.', { serverId }, (a) => [
  'POST',
  at(a.serverId, '/stop'),
])
tool(
  'server_trash',
  `${NOT_UNDONE}sends a server to the trash, where it can be brought back while its window lasts. Its owner loses it until then.`,
  { serverId, confirm: confirmName },
  (a) => ['POST', at(a.serverId, '/trash'), { confirmName: a.confirm }],
  gone,
)
tool(
  'server_untrash',
  'Brings a server back out of the trash, while its window lasts.',
  { serverId },
  (a) => ['POST', at(a.serverId, '/untrash')],
)
tool('server_rest', 'Puts a stopped server’s world into the archive store now.', { serverId }, (a) => [
  'POST',
  at(a.serverId, '/rest'),
])
tool(
  'server_purge',
  `${NOT_UNDONE}a server in the trash, gone for good now, world and all. It can't be undone.`,
  { serverId, confirm: confirmName },
  (a) => ['POST', at(a.serverId, '/purge'), { confirmName: a.confirm }],
  gone,
)

// ─── A server's pages ───────────────────────────────────────────────────────────────────────────

tool(
  'console_send',
  'Sends one command to a running server’s console, and answers with what it said back.',
  { serverId, command: ConsoleCommand.describe('One line, as typed in the console, without the slash') },
  (a) => ['POST', at(a.serverId, '/console'), { command: a.command }],
)
tool(
  'console_read',
  'The lines a server’s console printed lately, oldest first.',
  { serverId, lines: z.number().int().min(1).max(500).optional() },
  (a) => ['GET', at(a.serverId, `/console${query({ lines: a.lines })}`)],
  read,
)
tool(
  'server_identity_set',
  'What the identity settings set: the name, the description its page and Browse show, the icon or a picture of its own, and the tags. Each left out stays.',
  {
    serverId,
    name: Line.optional(),
    description: z.string().optional().describe('What its page and Browse say about it'),
    icon: Line.nullable().optional().describe('One of Cubepals’ icons by key, or null for none'),
    picture: z
      .string()
      .nullable()
      .optional()
      .describe('A 64 by 64 PNG in base64, its own icon; null goes back to the icon'),
    tags: z.array(Line).optional(),
  },
  ({ serverId: id, ...identity }) => ['PATCH', at(id, '/identity'), identity],
)
tool(
  'server_message_set',
  'Sets the message players see under the server’s name in their server list; it reaches the game at the server’s next start. Its other settings stay.',
  { serverId, motd: Line.max(200) },
  (a) => ['PUT', at(a.serverId, '/message'), { motd: a.motd }],
)
tool(
  'server_address_set',
  'Moves a server to a new address; the old one stops working.',
  { serverId, slug: Line.min(1) },
  (a) => ['PUT', at(a.serverId, '/address'), { slug: a.slug }],
)

const change = {
  serverId,
  add: z.array(z.object({ projectId: Line.min(1), versionId: Line.optional() })).optional(),
  remove: z.array(Line).optional().describe('Mod ids, as mods_list gives them'),
  moveTo: Line.optional().describe(
    'A newer Minecraft a refused plan offered. Moving a world forward is one-way: only when its owner said so',
  ),
}
tool(
  'mods_list',
  'The mods, plugins or datapacks a server runs.',
  { serverId },
  (a) => ['GET', at(a.serverId, '/mods')],
  read,
)
tool(
  'mods_search',
  'Finds mods or plugins for a server in the catalog.',
  { serverId, text: Line, offset: z.number().int().min(0).optional() },
  (a) => ['GET', at(a.serverId, `/mods/search${query({ text: a.text, offset: a.offset })}`)],
  read,
)
tool(
  'mods_plan',
  'What adding or removing mods would do, without doing it.',
  change,
  ({ serverId: id, ...c }) => ['POST', at(id, '/mods/plan'), c],
  read,
)
tool(
  'mods_change',
  'Adds or removes mods or plugins as the mods page does, applied as planned. Refused, with what fits instead, when it doesn’t fit.',
  { ...change, acknowledgeRevoked: z.boolean().optional() },
  ({ serverId: id, ...c }) => ['POST', at(id, '/mods'), c],
)

tool(
  'players_get',
  'A server’s whitelist, operators, bans and helpers, and whether the whitelist is on.',
  { serverId },
  (a) => ['GET', at(a.serverId, '/access')],
  read,
)
tool('whitelist_set', 'Turns a server’s whitelist on or off.', { serverId, enabled: z.boolean() }, (a) => [
  'PUT',
  at(a.serverId, '/access/whitelist'),
  { enabled: a.enabled },
])
const list = z.enum(['whitelist', 'operator', 'helper'])
tool(
  'player_add',
  'Puts a player on a server’s whitelist, or makes them an operator or a helper.',
  { serverId, list, name: Line.min(1) },
  (a) => ['POST', at(a.serverId, `/access/${a.list}`), { name: a.name }],
)
tool(
  'player_remove',
  'Takes a player off a server’s whitelist, operators or helpers.',
  { serverId, list, player },
  (a) => ['DELETE', at(a.serverId, `/access/${a.list}/${encodeURIComponent(a.player)}`)],
)
tool(
  'player_ban',
  `${NOT_UNDONE}bans a player from a server until pardoned; they are kept out from then on.`,
  { serverId, name: Line.min(1), reason: Line.optional(), confirm: confirmName },
  async (a) => {
    await confirmServer(a.serverId, a.confirm)
    return [
      'POST',
      at(a.serverId, '/access/ban'),
      { name: a.name, ...(a.reason ? { reason: a.reason } : {}) },
    ]
  },
  gone,
)
tool('player_pardon', 'Lifts a player’s ban from a server.', { serverId, player }, (a) => [
  'DELETE',
  at(a.serverId, `/access/ban/${encodeURIComponent(a.player)}`),
])
tool(
  'moderation_get',
  'A server’s moderation tools: whether they run, and what was given to whom.',
  { serverId },
  (a) => ['GET', at(a.serverId, '/moderation')],
  read,
)
tool(
  'moderation_set',
  'Turns a server’s moderation tools, and the chat filter with them, on or off.',
  { serverId, enabled: z.boolean(), chatFilter: z.boolean() },
  (a) => ['PUT', at(a.serverId, '/moderation'), { enabled: a.enabled, chatFilter: a.chatFilter }],
)

// ─── Browse ─────────────────────────────────────────────────────────────────────────────────────

tool(
  'listing_get',
  'Where a server stands in Browse, and why it isn’t shown when it isn’t.',
  { serverId },
  (a) => ['GET', at(a.serverId, '/listing')],
  read,
)
tool('listing_publish', 'Publishes a server to Browse, as its owner does from Share.', { serverId }, (a) => [
  'PUT',
  at(a.serverId, '/listing'),
  { public: true },
])
tool(
  'listing_unlist',
  `${NOT_UNDONE}takes a server out of Browse; its page closes to everyone but invited players.`,
  { serverId, confirm: confirmName },
  async (a) => {
    await confirmServer(a.serverId, a.confirm)
    return ['PUT', at(a.serverId, '/listing'), { public: false }]
  },
  gone,
)
tool(
  'official_set',
  'Sets or clears the "Run by Cubepals" mark on a server, with why for the audit log.',
  { serverId, official: z.boolean(), reason: Line.min(1) },
  (a) => ['PUT', at(a.serverId, '/official'), { official: a.official, reason: a.reason }],
)
tool(
  'allowlist_get',
  'The catalog projects Cubepals vouches for in Browse.',
  {},
  () => ['GET', '/allowlist'],
  read,
)
tool(
  'allowlist_add',
  'Allows a catalog project, by its id or slug, for servers listed in Browse.',
  { projectId: Line.min(1), note: Line.optional() },
  (a) => ['POST', '/allowlist', { projectId: a.projectId, ...(a.note ? { note: a.note } : {}) }],
)
tool(
  'allowlist_remove',
  'Disallows a catalog project; servers that run it may leave Browse.',
  { catalog: Line.min(1), projectId: Line.min(1) },
  (a) => ['DELETE', `/allowlist/${encodeURIComponent(a.catalog)}/${encodeURIComponent(a.projectId)}`],
)

// ─── The platform ───────────────────────────────────────────────────────────────────────────────

tool(
  'platform_get',
  'The admins’ platform switches and caps, with usage, sign-ups and spend.',
  {},
  () => ['GET', '/platform'],
  read,
)
tool(
  'platform_set',
  `${NOT_UNDONE}sets the platform switches and caps it names; the rest stay. These are for every player at once.`,
  {
    confirm: z.literal(PLATFORM).describe(`The word ${PLATFORM}, to confirm a change for every player`),
    provisioningEnabled: z.boolean().optional(),
    startsEnabled: z.boolean().optional(),
    publicListingEnabled: z.boolean().optional(),
    uploadsEnabled: z.boolean().optional(),
    storingEnabled: z.boolean().optional(),
    expiringEnabled: z.boolean().optional(),
    maxServers: z.number().int().optional(),
    maxRunningServers: z.number().int().optional(),
    maxFreeAccounts: z.number().int().optional(),
    dailySpendLimitCents: z.number().int().optional(),
  },
  ({ confirm: _, ...switches }) => ['PATCH', '/platform', switches],
  gone,
)
tool(
  'fly_suspend_get',
  'Whether servers put to sleep on Fly are suspended or stopped.',
  {},
  () => ['GET', '/platform/fly-suspend'],
  read,
)
tool(
  'fly_suspend_set',
  'Suspends or stops servers put to sleep on Fly; null leaves it to the deployment’s default.',
  { on: z.boolean().nullable() },
  (a) => ['PUT', '/platform/fly-suspend', { on: a.on }],
)
tool('catalog_refresh', 'Refreshes the mod catalog now rather than at the next hour.', {}, () => [
  'POST',
  '/platform/catalog-refresh',
])

// ─── Uploaded jars ──────────────────────────────────────────────────────────────────────────────

const sha512 = z
  .string()
  .regex(/^[0-9a-f]{128}$/)
  .describe('The jar’s sha512, as jar_checks gives it')
tool(
  'jar_checks',
  'Uploaded jars’ malware checks: quarantined, flagged and unread jars unless a state is named, each with what it matched or what its code does, and who uploaded it.',
  { state: z.enum(['quarantined', 'flagged', 'checking', 'clean']).optional() },
  (a) => ['GET', `/jar-checks${query({ state: a.state })}`],
  { readOnly: true },
)
tool(
  'jar_checks_refresh',
  'Fetches the lists of known malware now, and holds every upload to them.',
  {},
  () => ['POST', '/jar-checks/refresh'],
)
tool(
  'jar_release',
  'Lets a quarantined jar run again, on every server whose owner adds it: only for a jar found not to be malware. Its sha512 is named again as confirm.',
  { sha512, confirm: sha512.describe('The same sha512 again, to confirm') },
  (a) => {
    if (a.confirm !== a.sha512) throw new Error('Not done: confirm is not the jar’s sha512.')
    return ['POST', `/jar-checks/${a.sha512}/release`]
  },
)

// ─── Joins ──────────────────────────────────────────────────────────────────────────────────────

const moment = Line.describe('An ISO moment')
tool(
  'joins_list',
  'Joins, the newest first: each with its server, player, address, how it reached the server, when each step came and how it ended.',
  {
    server: Line.optional().describe('A server’s id, or its address’s slug'),
    player: player.optional(),
    address: Line.optional().describe('A whole address, or its first label'),
    since: moment.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  (a) => ['GET', `/joins${query(a)}`],
  read,
)
tool(
  'join_get',
  'One join with what explains it: every step with its time, the start its wake asked for step by step, the signals raised on it, and how often the player joined that server. By the join’s id, or a player’s join nearest a moment, or their latest.',
  {
    join: z.uuid().optional().describe('The join’s id, as joins_list gives it'),
    player: player.optional(),
    at: moment.optional(),
  },
  (a) => {
    if (a.join !== undefined) return ['GET', `/joins/${a.join}`]
    if (a.player === undefined) throw new Error('Not done: name a join, or a player.')
    return ['GET', `/joins/find${query({ player: a.player, at: a.at })}`]
  },
  read,
)
tool(
  'signals_list',
  'The signals still open, oldest first: what looked wrong in joins, wakes and servers, each with its figure and limit. With since, those closed since then too.',
  { since: moment.optional() },
  (a) => ['GET', `/signals${query({ since: a.since })}`],
  read,
)

// ─── Health ─────────────────────────────────────────────────────────────────────────────────────

tool(
  'health',
  'Production’s health: servers now, how long work takes, what failed, and the money.',
  {},
  () => ['GET', '/health'],
  read,
)
tool(
  'operations_list',
  'Operations, the newest first, by kind, age, slowness and outcome.',
  {
    kind: Line.optional().describe('wake, start, stop and the like'),
    since: Line.optional().describe('An ISO moment'),
    slow: z.number().optional().describe('Slower than this many seconds'),
    status: Line.optional().describe('succeeded or failed'),
    limit: z.number().int().min(1).max(200).optional(),
  },
  (filters) => ['GET', `/operations${query(filters)}`],
  read,
)
tool(
  'operation_get',
  'One operation, and where its time went step by step.',
  { operationId: z.uuid() },
  (a) => ['GET', `/operations/${a.operationId}`],
  read,
)

await server.connect(new StdioServerTransport())
