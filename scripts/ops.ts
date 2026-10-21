// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Accounts, their servers and the platform from the command line, without signing in to the
 * website (docs/production.md § From the command line). `scripts/ops-mcp.ts` offers the same to an
 * agent.
 *
 *   bun scripts/ops.ts accounts [search]            accounts whose email or name holds it
 *   bun scripts/ops.ts accounts create <email> --confirm <email> [--name <name>]
 *                                                   an account with no password, for a person to
 *                                                   run: its person signs in with the email link or
 *                                                   Google; nothing is sent until then
 *   bun scripts/ops.ts account <email|id>           standing, plan, limits, servers, what was done
 *   bun scripts/ops.ts plan <email|id> plus|free    comp an account onto Plus, or back to Free
 *   bun scripts/ops.ts limits <email|id> [--servers n] [--running n] [--hours n]
 *                                                   its own limits over its plan's; `--servers plan`
 *                                                   (or running, hours) gives back the plan's own
 *   bun scripts/ops.ts create <email|id> <name> [--play survival|creative] [--template <key>]
 *                                    [--size 5|10|20|more] [--region <key>]
 *                                                   a server for that account, as the web makes one
 *   bun scripts/ops.ts server <server>              one server, as its owner's page reads it
 *   bun scripts/ops.ts start|stop <server>
 *   bun scripts/ops.ts retry <server>               a server that didn't start last time, tried
 *                                                   again as its owner's Try again does; start
 *                                                   refuses it and says to use this
 *   bun scripts/ops.ts trash <server> --confirm <its name>
 *   bun scripts/ops.ts untrash <server>             back out of the trash, while its window lasts
 *   bun scripts/ops.ts rest <server>                a stopped server's world to the archive store now
 *   bun scripts/ops.ts purge <server> --confirm <its name>
 *                                                   a server in the trash, gone for good now
 *   bun scripts/ops.ts console <server> [command] [--lines n]
 *                                                   a command sent and its answer, or without one
 *                                                   the lines the console printed lately
 *   bun scripts/ops.ts identity <server> [--name <name>] [--description <text>]
 *                               [--icon <key>|none] [--tags a,b] [--address <slug>]
 *                                                   what its identity settings set
 *   bun scripts/ops.ts message <server> <text>      the message under its name in server lists
 *                                                   from its next start
 *   bun scripts/ops.ts mods <server> [search <text> | add <project[@version]>... | remove <id>...]
 *                          [--plan] [--move-to <version>] [--acknowledge-revoked]
 *                                                   its mods or plugins, found, added or removed as
 *                                                   the mods page does; --plan only shows the change
 *   bun scripts/ops.ts players <server>             its whitelist, operators, bans and helpers
 *   bun scripts/ops.ts whitelist <server> on|off
 *   bun scripts/ops.ts whitelist|operator|helper <server> add|remove <player>
 *   bun scripts/ops.ts ban <server> <player> --confirm <its name> [--reason <why>]
 *   bun scripts/ops.ts pardon <server> <player>
 *   bun scripts/ops.ts moderation <server> [on|off] [--chat-filter on|off]
 *                                                   the moderation tools, read or turned on or off
 *   bun scripts/ops.ts listing <server> [publish | unlist --confirm <its name>]
 *                                                   where it stands in Browse, or put in or out
 *   bun scripts/ops.ts notice <server> address --from <old address> | notice <server> unlisted
 *                                                   the owner's email for a new address or for
 *                                                   leaving Browse, for a change made before
 *                                                   Cubepals sent it on its own
 *   bun scripts/ops.ts official <server> on|off --reason <why>
 *                                                   the "Run by Cubepals" mark
 *   bun scripts/ops.ts allowlist [add <project> [--note <text>] | remove <catalog> <project>]
 *   bun scripts/ops.ts platform [set <switch> <value>... --confirm platform]
 *                                                   the admins' platform switches, as `platform`
 *                                                   names them: `set startsEnabled false`
 *   bun scripts/ops.ts platform fly-suspend [on|off|default]
 *   bun scripts/ops.ts platform refresh-catalog
 *   bun scripts/ops.ts jars [quarantined|flagged|checking|clean] | jars refresh
 *                    | jars release <sha512> --confirm <sha512>
 *                                                   uploaded jars' malware checks: what each matched
 *                                                   or does, the lists fetched now, or a jar that
 *                                                   isn't malware let run again
 *   bun scripts/ops.ts health [--window 24h|7d|30d] [--json]
 *                                                   servers now, how long work takes, what failed,
 *                                                   the slowest, and the money
 *   bun scripts/ops.ts operations [--kind wake] [--since 24h|7d|<ISO>] [--slow <seconds>]
 *                                 [--status failed] [--limit n] [--json]
 *                                                   operations, the newest first
 *   bun scripts/ops.ts operation <op>               one operation, and where its time went
 *   bun scripts/ops.ts joins [--server <id|slug>] [--player <name|uuid>] [--address <name>]
 *                            [--since 24h|7d|<ISO>] [--limit n] [--json]
 *                                                   joins, the newest first, one a line
 *   bun scripts/ops.ts join <join id|name|uuid> [--at <ISO>] [--markdown|--json]
 *                                                   one join as an incident report: by its id, or a
 *                                                   player's nearest --at, or their latest
 *   bun scripts/ops.ts signals [--since 7d|<ISO>] [--json] | signals close <id>
 *                                                   the open signals, oldest first, one a line, and
 *                                                   nothing at all while none is open; --since adds
 *                                                   those closed since
 *
 * With --production, it reaches production through `fly proxy` with production's own values
 * (scripts/lib/production-reach.ts). Otherwise OPERATOR_API and OPERATOR_TOKEN say where, as for
 * `scripts/runtimes.ts`. OPERATOR (or USER) is who the audit log says acted, as `operator:<name>`.
 * What takes something away from someone is named again with --confirm first, and a server, an
 * operation and a console command are checked before anything is called (lib/operator-inputs.ts).
 *
 * Parts (`ops/`):
 * - `join-report.ts`: a join as an incident report, and the one-line forms of joins and signals.
 */
import type { HealthOperationView, HealthView, HealthWindow, OperationStepsView } from '@blockly/contracts'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import type { JoinDetailView, JoinView, SignalView } from '@blockly/contracts/join-records'
import { z } from 'zod'
import { healthReport, operationLine, stepsReport } from './lib/health-report.ts'
import { flags, operatorCli, withoutSecrets } from './lib/operator-cli.ts'
import { ConsoleCommand, namesServer, PLATFORM } from './lib/operator-inputs.ts'
import { reachProduction } from './lib/production-reach.ts'
import { joinLine, joinReport, signalLine } from './ops/join-report.ts'

const [command = 'help', ...rest] = process.argv.slice(2).filter((arg) => arg !== '--production')

const { positional, options } = flags(rest)
const option = (name: string) => options.get(name)?.at(-1)

const { fail, api } = operatorCli('ops', '/ops/v1', 'docs/production.md')

const say = (line: string) => process.stdout.write(`${withoutSecrets(line)}\n`)
const show = (value: unknown) => say(JSON.stringify(value, null, 2))
const first = (what: string) => positional[0] ?? fail(`${command} needs ${what}`)
const uuid = (what: string) => {
  const given = first(what)
  return z.uuid().safeParse(given).success ? given : fail(`${command} needs ${what}, a uuid`)
}
const serverId = () => uuid('a server id')
/** Stops here unless --confirm names the server exactly. */
async function confirmServer(id: string): Promise<void> {
  const confirm = option('confirm') ?? fail(`${command} needs --confirm, the server's name exactly`)
  if (!(await namesServer(api, id, confirm))) fail(`--confirm is not the server's name`)
}
const encoded = (ref: string) => encodeURIComponent(ref)
const second = (what: string) => positional[1] ?? fail(`${command} needs ${what}`)
const onOff = (given: string | undefined, what: string) =>
  given === 'on' ? true : given === 'off' ? false : fail(`${what} is on or off`)

/** A limit as given: a whole number, or `plan` for the plan's own. */
function limit(name: string, current: number | null | undefined): number | null {
  const given = option(name)
  if (given === undefined) return current ?? null
  if (given === 'plan') return null
  const value = Number(given)
  if (!Number.isInteger(value)) fail(`--${name} is a whole number, or plan`)
  return value
}

/** `24h`, `7d` or `90m` ago, or a moment as given. */
function since(given: string): string {
  const ago = /^(\d+)([mhd])$/.exec(given)
  if (ago === null) return given
  const unit = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS }[ago[2] as 'm' | 'h' | 'd']
  return new Date(Date.now() - Number(ago[1]) * unit).toISOString()
}

if (process.argv.includes('--production'))
  await reachProduction().catch((error: Error) => fail(error.message))

switch (command) {
  case 'accounts': {
    if (positional[0] === 'create') {
      const email = second('an email address')
      if (option('confirm') !== email) fail('accounts create needs --confirm, the same address again')
      show(await api('POST', '/accounts', { email, ...(option('name') ? { name: option('name') } : {}) }))
      break
    }
    const search = positional[0] ? `?search=${encoded(positional[0])}` : ''
    const found = (await api('GET', `/accounts${search}`)) as {
      total: number
      accounts: Array<{ userId: string; email: string; plan: string; status: string; servers: number }>
    }
    for (const a of found.accounts)
      say(`${a.userId}  ${a.email}  ${a.plan}  ${a.status}  ${a.servers} servers`)
    say(`${found.accounts.length} of ${found.total}`)
    break
  }
  case 'account':
    show(await api('GET', `/accounts/${encoded(first('an email or account id'))}`))
    break
  case 'plan': {
    const plan = positional[1] ?? fail('plan needs the account and plus or free')
    show(await api('PUT', `/accounts/${encoded(first('an email or account id'))}/plan`, { plan }))
    break
  }
  case 'limits': {
    const account = encoded(first('an email or account id'))
    const { limits } = (await api('GET', `/accounts/${account}`)) as {
      limits: { maxServers?: number; maxRunning?: number; includedUnits?: number }
    }
    show(
      await api('PUT', `/accounts/${account}/limits`, {
        maxServers: limit('servers', limits.maxServers),
        maxRunning: limit('running', limits.maxRunning),
        includedUnits: limit('hours', limits.includedUnits),
      }),
    )
    break
  }
  case 'create': {
    const name = positional[1] ?? fail('create needs the account and a name')
    const template = option('template')
    show(
      await api('POST', '/servers', {
        owner: first('an email or account id'),
        name,
        ...(template === undefined ? {} : { from: { kind: 'template', key: template } }),
        ...(option('play') === undefined ? {} : { playStyle: option('play') }),
        ...(option('size') === undefined ? {} : { partySize: option('size') }),
        ...(option('region') === undefined ? {} : { regionKey: option('region') }),
      }),
    )
    break
  }
  case 'server':
    show(await api('GET', `/servers/${serverId()}`))
    break
  case 'start':
  case 'stop':
  case 'retry':
  case 'untrash':
  case 'rest':
    show(await api('POST', `/servers/${serverId()}/${command}`))
    break
  case 'trash':
  case 'purge': {
    const confirmName = option('confirm') ?? fail(`${command} needs --confirm, the server's name exactly`)
    show(await api('POST', `/servers/${serverId()}/${command}`, { confirmName }))
    break
  }
  case 'console': {
    const server = `/servers/${serverId()}/console`
    const sent = positional.slice(1).join(' ')
    if (sent && !ConsoleCommand.safeParse(sent).success)
      fail('a console command is one line of plain text, without control characters')
    if (sent) say(((await api('POST', server, { command: sent })) as { output: string }).output)
    else {
      const lines = option('lines') ? `?lines=${option('lines')}` : ''
      const { lines: printed } = (await api('GET', `${server}${lines}`)) as {
        lines: Array<{ at: string; text: string }>
      }
      for (const line of printed) say(`${line.at}  ${line.text}`)
    }
    break
  }
  case 'identity': {
    const server = serverId()
    const icon = option('icon')
    const identity = {
      ...(option('name') === undefined ? {} : { name: option('name') }),
      ...(option('description') === undefined ? {} : { description: option('description') }),
      ...(icon === undefined ? {} : { icon: icon === 'none' ? null : icon }),
      ...(option('tags') === undefined ? {} : { tags: option('tags')?.split(',').filter(Boolean) }),
    }
    if (Object.keys(identity).length > 0) show(await api('PATCH', `/servers/${server}/identity`, identity))
    if (option('address') !== undefined)
      show(await api('PUT', `/servers/${server}/address`, { slug: option('address') }))
    if (Object.keys(identity).length === 0 && option('address') === undefined)
      fail('identity needs --name, --description, --icon, --tags or --address')
    break
  }
  case 'message':
    show(await api('PUT', `/servers/${serverId()}/message`, { motd: positional.slice(1).join(' ') }))
    break
  case 'mods': {
    const mods = `/servers/${serverId()}/mods`
    const [, action, ...refs] = positional
    if (action === undefined) show(await api('GET', mods))
    else if (action === 'search') show(await api('GET', `${mods}/search?text=${encoded(refs.join(' '))}`))
    else if (action === 'add' || action === 'remove') {
      if (refs.length === 0) fail(`mods ${action} needs what to ${action}`)
      const change = {
        ...(action === 'add'
          ? {
              add: refs.map((ref) => {
                const [projectId, versionId] = ref.split('@')
                return { projectId, ...(versionId ? { versionId } : {}) }
              }),
            }
          : { remove: refs }),
        ...(option('move-to') ? { moveTo: option('move-to') } : {}),
      }
      if (option('plan')) show(await api('POST', `${mods}/plan`, change))
      else
        show(
          await api('POST', mods, {
            ...change,
            acknowledgeRevoked: option('acknowledge-revoked') === 'true',
          }),
        )
    } else fail('mods takes search, add or remove')
    break
  }
  case 'players':
    show(await api('GET', `/servers/${serverId()}/access`))
    break
  case 'whitelist':
  case 'operator':
  case 'helper': {
    const access = `/servers/${serverId()}/access`
    const action = second('add, remove, or for the whitelist on or off')
    if (command === 'whitelist' && (action === 'on' || action === 'off'))
      show(await api('PUT', `${access}/whitelist`, { enabled: action === 'on' }))
    else if (action === 'add')
      show(await api('POST', `${access}/${command}`, { name: positional[2] ?? fail('add needs a player') }))
    else if (action === 'remove')
      show(
        await api(
          'DELETE',
          `${access}/${command}/${encoded(positional[2] ?? fail('remove needs a player'))}`,
        ),
      )
    else fail(`${command} takes add or remove`)
    break
  }
  case 'ban': {
    const name = second('a player')
    await confirmServer(serverId())
    show(
      await api('POST', `/servers/${serverId()}/access/ban`, {
        name,
        ...(option('reason') ? { reason: option('reason') } : {}),
      }),
    )
    break
  }
  case 'pardon':
    show(await api('DELETE', `/servers/${serverId()}/access/ban/${encoded(second('a player'))}`))
    break
  case 'moderation': {
    const moderation = `/servers/${serverId()}/moderation`
    if (positional[1] === undefined) show(await api('GET', moderation))
    else {
      const enabled = onOff(positional[1], 'moderation')
      const filter = option('chat-filter')
      show(
        await api('PUT', moderation, {
          enabled,
          chatFilter: filter === undefined ? false : onOff(filter, '--chat-filter'),
        }),
      )
    }
    break
  }
  case 'listing': {
    const listing = `/servers/${serverId()}/listing`
    const action = positional[1]
    if (action === undefined) show(await api('GET', listing))
    else if (action === 'publish' || action === 'unlist') {
      if (action === 'unlist') await confirmServer(serverId())
      show(await api('PUT', listing, { public: action === 'publish' }))
    } else fail('listing takes publish or unlist')
    break
  }
  case 'notice': {
    const notice = `/servers/${serverId()}/notice`
    const kind = positional[1]
    if (kind === 'address')
      show(await api('POST', notice, { kind, from: option('from') ?? fail('notice address needs --from') }))
    else if (kind === 'unlisted') show(await api('POST', notice, { kind }))
    else fail('notice takes address or unlisted')
    break
  }
  case 'official': {
    const official = onOff(positional[1], 'official')
    const reason = option('reason') ?? fail('official needs --reason, which the audit log keeps')
    show(await api('PUT', `/servers/${serverId()}/official`, { official, reason }))
    break
  }
  case 'allowlist': {
    const [action, ...rest] = positional
    if (action === undefined) show(await api('GET', '/allowlist'))
    else if (action === 'add')
      show(
        await api('POST', '/allowlist', {
          projectId: rest[0] ?? fail('allowlist add needs a project'),
          ...(option('note') ? { note: option('note') } : {}),
        }),
      )
    else if (action === 'remove') {
      const needs = 'allowlist remove needs the catalog and the project, as allowlist lists them'
      const catalog = rest[0] ?? fail(needs)
      const project = rest[1] ?? fail(needs)
      show(await api('DELETE', `/allowlist/${encoded(catalog)}/${encoded(project)}`))
    } else fail('allowlist takes add or remove')
    break
  }
  case 'platform': {
    const [action, ...rest] = positional
    if (action === undefined) show(await api('GET', '/platform'))
    else if (action === 'set') {
      if (rest.length === 0 || rest.length % 2 !== 0)
        fail('platform set takes a switch and its value, as many as you like')
      if (option('confirm') !== PLATFORM)
        fail(`platform set changes it for every player: confirm with --confirm ${PLATFORM}`)
      const change: Record<string, boolean | number> = {}
      for (let i = 0; i < rest.length; i += 2) {
        const value = rest[i + 1] ?? ''
        change[rest[i] ?? ''] = value === 'true' || value === 'false' ? value === 'true' : Number(value)
      }
      show(await api('PATCH', '/platform', change))
    } else if (action === 'fly-suspend') {
      const given = rest[0]
      if (given === undefined) show(await api('GET', '/platform/fly-suspend'))
      else
        show(
          await api('PUT', '/platform/fly-suspend', {
            on: given === 'default' ? null : onOff(given, 'fly-suspend'),
          }),
        )
    } else if (action === 'refresh-catalog') show(await api('POST', '/platform/catalog-refresh'))
    else fail('platform takes set, fly-suspend or refresh-catalog')
    break
  }
  case 'jars': {
    const [action, sha512] = positional
    if (action === 'refresh') show(await api('POST', '/jar-checks/refresh'))
    else if (action === 'release') {
      if (sha512 === undefined || !/^[0-9a-f]{128}$/.test(sha512)) fail('jars release takes a jar’s sha512')
      if (option('confirm') !== sha512)
        fail('jars release lets it run on every server again: confirm with --confirm <its sha512>')
      show(await api('POST', `/jar-checks/${sha512}/release`))
    } else show(await api('GET', `/jar-checks${action === undefined ? '' : `?state=${encoded(action)}`}`))
    break
  }
  case 'health': {
    const window = (option('window') ?? '24h') as HealthWindow
    if (!['24h', '7d', '30d'].includes(window)) fail('--window is 24h, 7d or 30d')
    const view = (await api('GET', '/health')) as HealthView
    if (option('json')) show(view)
    else for (const line of healthReport(view, window)) say(line)
    break
  }
  case 'operations': {
    const query = new URLSearchParams()
    for (const name of ['kind', 'slow', 'status', 'limit']) {
      const given = option(name)
      if (given !== undefined) query.set(name, given)
    }
    const from = option('since')
    if (from !== undefined) query.set('since', since(from))
    const { operations } = (await api('GET', `/operations?${query}`)) as { operations: HealthOperationView[] }
    if (option('json')) show(operations)
    else {
      for (const op of operations) say(operationLine(op))
      say(`${operations.length} found`)
    }
    break
  }
  case 'operation': {
    const op = (await api('GET', `/operations/${uuid('an operation id')}`)) as OperationStepsView
    if (option('json')) show(op)
    else for (const line of stepsReport(op)) say(line)
    break
  }
  case 'joins': {
    const query = new URLSearchParams()
    for (const name of ['server', 'player', 'address', 'limit']) {
      const given = option(name)
      if (given !== undefined) query.set(name, given)
    }
    const from = option('since')
    if (from !== undefined) query.set('since', since(from))
    const { joins } = (await api('GET', `/joins?${query}`)) as { joins: JoinView[] }
    if (option('json')) show(joins)
    else for (const join of joins) say(joinLine(join))
    break
  }
  case 'join': {
    const ref = first('a join id, or a player’s name or uuid')
    // The API tells a join's id from a player's: both can be any version of uuid.
    const at = option('at')
    const query = new URLSearchParams({ player: ref, ...(at === undefined ? {} : { at: since(at) }) })
    const view = (await api('GET', `/joins/find?${query}`)) as JoinDetailView
    if (option('json')) show(view)
    else for (const line of joinReport(view)) say(line)
    break
  }
  case 'signals': {
    if (positional[0] === 'close') {
      const id = Number(second('a signal’s number'))
      if (!Number.isInteger(id) || id <= 0)
        fail('signals close takes a signal’s number, as signals prints it')
      show(await api('POST', `/signals/${id}/close`))
      break
    }
    const from = option('since')
    const query = from === undefined ? '' : `?since=${encoded(since(from))}`
    const { signals } = (await api('GET', `/signals${query}`)) as { signals: SignalView[] }
    // Nothing else: a script that polls this sees a change only when a signal opens or closes.
    if (option('json')) show(signals)
    else for (const signal of signals) say(signalLine(signal))
    break
  }
  default:
    say(
      'bun scripts/ops.ts [--production] accounts|account|plan|limits|create|server|start|stop|retry|trash|untrash|rest|purge|console|identity|message|mods|players|whitelist|operator|helper|ban|pardon|moderation|listing|notice|official|allowlist|platform|jars|health|operations|operation|joins|join|signals',
    )
    say('See the top of scripts/ops.ts, and docs/production.md.')
    if (command !== 'help') process.exit(1)
}
// The proxy production is reached through would keep this process alive.
process.exit(0)
