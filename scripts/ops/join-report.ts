// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One join, written for a person: `ops.ts join --markdown` prints it as an incident report, with
 * who joined, how they reached the server, every step in order with its time, what crossed a limit,
 * and what nobody recorded. And the one-line forms `ops.ts joins` and `ops.ts signals` print. Pure:
 * it reads only the views the operators' API answers with.
 */
import type { JoinDetailView, JoinView, SignalView } from '@blockly/contracts/join-records'

/** Each kind of signal in words. */
const KINDS: Record<string, string> = {
  slow_join: 'Slow join',
  left_while_loading: 'Left while loading',
  short_stay: 'Short stay',
  looked_back: 'Looked again, didn’t come back',
  watched_address: 'Join at a watched address',
  look_no_join: 'Looks at a watched address',
  wake_no_join: 'Woken, nobody joined',
  repeated_wakes: 'Woken again and again',
  crowd: 'Crowd',
  kicked_early: 'Kicked soon after joining',
  slow_tick: 'Slow tick',
  legacy_login_listener: 'Plugin listening at login',
}

const kindOf = (kind: string) => KINDS[kind] ?? kind
const time = (iso: string) => iso.slice(11, 19)
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

/** `<figure> (limit <limit>)`, or what of it the signal has. */
function figure(detail: Record<string, unknown>): string | null {
  if (detail.figure === undefined) return null
  return detail.limit === undefined ? `${detail.figure}` : `${detail.figure} (limit ${detail.limit})`
}

/** `#<id> <HH:MM UTC> <kind> · <server> · <player> via <address> · <figure> (limit <limit>)`. */
export function signalLine(signal: SignalView): string {
  const { detail } = signal
  const player = text(detail.player)
  const address = text(detail.address)
  const who = player !== null && address !== null ? `${player} via ${address}` : (player ?? address)
  const parts = [kindOf(signal.kind), text(detail.server), who, figure(detail)].filter(
    (part) => part !== null,
  )
  return `#${signal.id} ${signal.at.slice(11, 16)} UTC ${parts.join(' · ')}`
}

/** One join on a line: when, who, where, how, and how it ended. */
export function joinLine(join: JoinView): string {
  const who = join.playerName ?? (join.kind === 'look' ? 'a server list' : 'someone')
  const took =
    join.loginAt !== null && join.inWorldAt !== null
      ? ` · in the world in ${seconds(join.loginAt, join.inWorldAt)} s`
      : ''
  const ended = join.leftReason === null ? '' : ` · ${join.leftReason}`
  return `${join.connectedAt.slice(0, 19).replace('T', ' ')} ${join.id} ${join.serverName ?? join.address} · ${who} via ${join.address} · ${join.path ?? join.kind}${took}${ended}`
}

const seconds = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10

/** Every moment of the join and its wake's start, in order: when, where, what. */
function timeline(view: JoinDetailView): { at: string; where: string; what: string }[] {
  const { join, wake } = view
  const moments: [string | null, string, string][] = [
    [join.pingedAt, 'edge', 'Server list pinged it'],
    [join.connectedAt, 'edge', `Connected to ${join.address}`],
    [join.wakeAskedAt, 'edge', 'Asked the control plane to wake the server'],
    [join.readyAt, 'edge', 'Server up'],
    [
      join.handedAt,
      'edge',
      join.path === 'held' ? 'Handed from the waiting room to the server' : 'Handed to the server',
    ],
    [join.loginAt, 'server', 'Logged in'],
    [join.configureStartedAt, 'server', 'Configuration began'],
    [join.configuredAt, 'server', 'Configuration done'],
    [
      join.inWorldAt,
      'server',
      `In the world${join.tick === null ? '' : ` (${join.tick.mspt} ms a tick, ${join.tick.online} online)`}`,
    ],
    [
      join.leftAt,
      join.serverSide === 'reported' ? 'server' : 'edge',
      `Left${join.leftReason === null ? '' : `: ${join.leftReason}`}`,
    ],
    [join.pingedAfterAt, 'edge', 'Server list pinged it again'],
    ...(wake?.steps ?? []).map((step): [string, string, string] => [
      step.at,
      'control',
      `${wake?.kind}: ${step.step}`,
    ]),
  ]
  return moments
    .flatMap(([at, where, what]) => (at === null ? [] : [{ at, where, what }]))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** What nobody recorded of the join, in plain words. */
function unknowns(view: JoinDetailView): string[] {
  const { join } = view
  const lines: string[] = []
  if (join.detail.edge === 'missing')
    lines.push('- The edge’s half is missing: no connection the edge reported matched this join.')
  if (join.serverSide !== 'reported')
    lines.push(
      '- The server didn’t report its side: the join reporter isn’t on it (JOIN_REPORTER), it isn’t a Paper server, or it hasn’t fully booted since the reporter was turned on.',
    )
  else if (join.configureStartedAt === null && join.configuredAt === null)
    lines.push('- No configuration times: Paper older than 1.21.7 doesn’t report them.')
  if (join.serverSide === 'reported' && join.loginAt === null)
    lines.push('- No login time: the server’s word of it didn’t reach this join.')
  if (join.pingedAt === null) lines.push('- No server-list ping before the join.')
  if (join.serverSide === 'reported' && join.inWorldAt === null)
    lines.push('- Never reached the world, by the server’s word.')
  if (join.leftAt === null) lines.push('- No leaving recorded: still on, or neither side has said yet.')
  if (join.wakeOperationId !== null && view.wake === null) lines.push('- Its wake’s start is no longer kept.')
  return lines
}

/** The join as an incident report, in Markdown. */
export function joinReport(view: JoinDetailView): string[] {
  const { join } = view
  return [
    `# ${join.serverName ?? join.address}: ${join.playerName ?? 'unknown player'}, ${join.connectedAt.slice(0, 10)} ${time(join.connectedAt)} UTC`,
    ...who(view),
    ...howTheyCame(view),
    ...timelineTable(view),
    ...lookedWrong(view),
    '',
    '## What we don’t know',
    '',
    ...(unknowns(view).length === 0 ? ['Nothing: both halves told of every step.'] : unknowns(view)),
  ]
}

function who({ join, joinsOnServer }: JoinDetailView): string[] {
  return [
    '',
    '## Who',
    '',
    `- ${join.playerName ?? 'Unknown'}${join.playerUuid === null ? '' : ` (${join.playerUuid})`}`,
    `- Game protocol: ${join.protocol ?? 'unknown'}`,
    `- Joins of this server in the last 35 days: ${joinsOnServer}`,
  ]
}

const ADDRESS_KINDS: Record<string, string> = {
  kept: ' (a kept address)',
  old_domain: ' (an old play domain)',
}

function howTheyCame({ join, wake }: JoinDetailView): string[] {
  return [
    '',
    '## How they reached us',
    '',
    `- Address: ${join.address}${ADDRESS_KINDS[join.addressKind ?? ''] ?? ''}`,
    `- Edge: ${join.edgeId ?? 'none reported'}${join.edgeRegion ? ` in ${join.edgeRegion}` : ''}`,
    `- Path: ${PATHS[join.path ?? ''] ?? 'not reported'}`,
    ...(wake === null ? [] : [`- Wake: ${wake.kind} ${wake.id}, ${wake.status}`]),
    ...(join.bytesUp === null ? [] : [`- Sent: ${join.bytesUp} bytes up, ${join.bytesDown ?? 0} down`]),
  ]
}

function timelineTable(view: JoinDetailView): string[] {
  const started = new Date(Date.parse(view.join.connectedAt)).toISOString()
  return [
    '',
    '## Timeline (UTC)',
    '',
    '| Time | +s | Where | Event |',
    '|---|---|---|---|',
    ...timeline(view).map(
      (m) => `| ${time(m.at)}.${m.at.slice(20, 23)} | ${seconds(started, m.at)} | ${m.where} | ${m.what} |`,
    ),
  ]
}

function lookedWrong({ signals }: JoinDetailView): string[] {
  const lines = signals.map((s) => {
    const shown = figure(s.detail)
    return `- ${kindOf(s.kind)}${shown === null ? '' : `: ${shown}`}`
  })
  return ['', '## What looked wrong', '', ...(lines.length === 0 ? ['Nothing crossed a limit.'] : lines)]
}

const PATHS: Record<string, string> = {
  direct: 'straight to the running server',
  held: 'through the waiting room, while the server woke',
  refused: 'turned away at the door',
}
