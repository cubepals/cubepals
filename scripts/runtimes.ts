// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where servers run, when a deployment runs several runtimes (docs/runtimes.md).
 *
 *   bun scripts/runtimes.ts summary [--days n]      runtimes, servers on each, rules, moves, decisions
 *   bun scripts/runtimes.ts rules                   the placement rules, in the order they are read
 *   bun scripts/runtimes.ts rule add <runtime> --percent n [--account <email|id>]… [--region <key>]…
 *                                    [--plan <plan>]… [--note <text>] [--disabled]
 *                                                   send a share of matching NEW servers there
 *   bun scripts/runtimes.ts rule set <rule> [--percent n] [--account …]… [--region …]… [--plan …]…
 *                                    [--note <text>]
 *   bun scripts/runtimes.ts rule on|off <rule>      turn a rule on, or off (new servers only)
 *   bun scripts/runtimes.ts where <server>          its runtime, and every decision about it
 *   bun scripts/runtimes.ts move <server>… --to <runtime>
 *                                                   move existing servers: each at its next quiet moment
 *   bun scripts/runtimes.ts stay <server>…          call off a move not yet made
 *   bun scripts/runtimes.ts report [--from <date>] [--to <date>] [--json]
 *                                                   each runtime's cost against its servers' revenue
 *
 * For example, five servers to the fleet, everything else where it is:
 *   bun scripts/runtimes.ts move <id1> <id2> <id3> <id4> <id5> --to fleet
 * and later 5% of new Plus servers in Europe:
 *   bun scripts/runtimes.ts rule add fleet --percent 5 --plan plus --region eu --note "canary"
 *
 * It talks to the control plane's operator API on its internal listener, which only the
 * deployment's private network reaches: OPERATOR_API is its base URL (http://host:port) and
 * OPERATOR_TOKEN its bearer token. OPERATOR (or USER) is who the decisions say acted. A rule never
 * moves a server already made; only `move` does, and the server stops for it if it was running.
 */

import { flags, operatorCli } from './lib/operator-cli.ts'

const [command = 'help', ...rest] = process.argv.slice(2)

const { positional, options } = flags(rest)
const option = (name: string) => options.get(name)?.at(-1)
const all = (name: string) => options.get(name)

const { fail, api } = operatorCli('runtimes', '/runtimes/v1', 'docs/runtimes.md')

const say = (line: string) => process.stdout.write(`${line}\n`)
const show = (value: unknown) => say(JSON.stringify(value, null, 2))
const dollars = (cents: number | null) => (cents === null ? '-' : `$${(cents / 100).toFixed(2)}`)

function table(head: string[], rows: string[][]) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  for (const row of [head, ...rows]) say(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  '))
}

/** What a rule says, from the options given. */
function ruleBody(): Record<string, unknown> {
  const percent = option('percent')
  return {
    ...(percent === undefined ? {} : { percent: Number(percent) }),
    ...(all('account') === undefined ? {} : { accounts: all('account') }),
    ...(all('region') === undefined ? {} : { regions: all('region') }),
    ...(all('plan') === undefined ? {} : { plans: all('plan') }),
    ...(option('note') === undefined ? {} : { note: option('note') }),
  }
}

interface Report {
  from: string
  to: string
  runtimes: Array<{
    provider: string
    servers: number
    serversRan: number
    runningHours: number
    activeHours: number
    playerHours: number
    infraCents: number
    idleCents: number
    runningUtilization: number | null
    revenueCents: number
    feeCents: number
    marginCents: number
    marginPercent: number | null
    perServerCents: number | null
    perAllocatedGbMonthCents: number | null
    perPlayedHourCents: number | null
  }>
  machines: Array<{
    provider: string
    name: string
    region: string
    state: string
    monthlyCents: number | null
    utilization: number | null
    observedUtilization: number | null
    strandedMemoryMb: number
    servers: number
  }>
  assumptions: Record<string, string>
}

function printReport(report: Report) {
  say(`From ${report.from} to ${report.to}`)
  say('')
  const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`)
  table(
    [
      'RUNTIME',
      'SERVERS',
      'RAN',
      'HOURS',
      'PLAYED H',
      'COST',
      'IDLE',
      'REVENUE',
      'FEES',
      'MARGIN',
      '/SERVER',
      '/GB-MONTH',
      '/PLAYED H',
    ],
    report.runtimes.map((r) => [
      r.provider,
      String(r.servers),
      String(r.serversRan),
      r.runningHours.toFixed(1),
      r.activeHours.toFixed(1),
      dollars(r.infraCents),
      `${dollars(r.idleCents)}${r.runningUtilization === null ? '' : ` (ran ${percent(r.runningUtilization)})`}`,
      dollars(r.revenueCents),
      dollars(r.feeCents),
      `${dollars(r.marginCents)} (${percent(r.marginPercent)})`,
      dollars(r.perServerCents),
      dollars(r.perAllocatedGbMonthCents),
      dollars(r.perPlayedHourCents),
    ]),
  )
  if (report.machines.length > 0) {
    say('')
    table(
      ['RUNTIME', 'MACHINE', 'REGION', 'STATE', 'MONTHLY', 'SERVERS', 'ALLOCATED', 'IN USE', 'STRANDED'],
      report.machines.map((m) => [
        m.provider,
        m.name,
        m.region,
        m.state,
        dollars(m.monthlyCents),
        String(m.servers),
        percent(m.utilization),
        percent(m.observedUtilization),
        `${m.strandedMemoryMb} MB`,
      ]),
    )
  }
  say('')
  for (const [name, said] of Object.entries(report.assumptions)) say(`${name}: ${said}`)
}

switch (command) {
  case 'summary':
    show(await api('GET', `/summary${option('days') ? `?days=${option('days')}` : ''}`))
    break
  case 'rules':
    show(await api('GET', '/rules'))
    break
  case 'rule': {
    const [action, target] = positional
    if (action === 'add') {
      if (!target) fail('rule add needs the runtime new servers go to')
      if (option('percent') === undefined) fail('rule add needs --percent')
      show(
        await api('POST', '/rules', { provider: target, ...ruleBody(), enabled: !options.has('disabled') }),
      )
    } else if (action === 'set' || action === 'on' || action === 'off') {
      if (!target) fail(`rule ${action} needs a rule id`)
      const body = action === 'set' ? ruleBody() : { enabled: action === 'on' }
      show(await api('PATCH', `/rules/${target}`, body))
    } else fail('rule add|set|on|off')
    break
  }
  case 'where':
    show(await api('GET', `/servers/${positional[0] ?? fail('where needs a server id')}`))
    break
  case 'move': {
    const to = option('to') ?? fail('move needs --to <runtime>')
    if (positional.length === 0) fail('move needs at least one server id')
    for (const id of positional) {
      await api('POST', `/servers/${id}/move`, { to })
      say(`${id}: moves to ${to} at its next quiet moment`)
    }
    break
  }
  case 'stay':
    if (positional.length === 0) fail('stay needs at least one server id')
    for (const id of positional) {
      await api('DELETE', `/servers/${id}/move`)
      say(`${id}: stays where it is`)
    }
    break
  case 'report': {
    const params = new URLSearchParams()
    if (option('from')) params.set('from', option('from') ?? '')
    if (option('to')) params.set('to', option('to') ?? '')
    const report = (await api('GET', `/economics${params.size === 0 ? '' : `?${params}`}`)) as Report
    if (options.has('json')) show(report)
    else printReport(report)
    break
  }
  default:
    say('bun scripts/runtimes.ts summary|rules|rule|where|move|stay|report')
    say('See the top of scripts/runtimes.ts, and docs/runtimes.md.')
    if (command !== 'help') process.exit(1)
}
