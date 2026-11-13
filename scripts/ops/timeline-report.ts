// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One server's story, in time order, for `ops.ts timeline <server>`: each operation with how it
 * went and why (its marks: `other_spec`, `changed:*`, `slept`, `memory_lost`, …), each join with
 * how far it got and how its session ended, and each signal raised about it. Pure: the command
 * reads the operators' API, this only writes it out.
 */
import type { OperationStepsView } from '@blockly/contracts'
import type { JoinView, SignalView } from '@blockly/contracts/join-records'

/** Steps every operation reports as it goes; the rest are marks that say why, and are shown. */
const PLAIN = new Set([
  'queued',
  'attempt',
  'allocating',
  'storage',
  'compute',
  'booting',
  'resuming',
  'starting',
  'loading_world',
  'verifying',
  'access',
  'other_spec',
])

interface Line {
  at: string
  text: string
}

const clock = (iso: string) => iso.slice(11, 19)
const secondsBetween = (from: string | null, to: string | null) =>
  from === null || to === null ? null : Math.round((Date.parse(to) - Date.parse(from)) / 1000)

/** How an operation went in a line: its outcome and time, whether a start resumed, and what it marked. */
function operationLine(op: OperationStepsView): Line {
  const steps = op.steps.map((s) => s.step)
  const way =
    steps.includes('resuming') && !steps.includes('booting')
      ? 'resumed'
      : steps.includes('booting')
        ? 'booted'
        : null
  const marks = steps.filter((step) => !PLAIN.has(step))
  const why = steps.includes('other_spec') ? ['other_spec', ...marks] : marks
  const attempts = steps.filter((step) => step === 'attempt').length
  const parts = [
    `op     ${op.kind.padEnd(10)} ${`${op.seconds}s`.padStart(7)}  ${op.status}`,
    ...(way === null ? [] : [way]),
    ...(why.length === 0 ? [] : [`(${why.join(', ')})`]),
    ...(attempts > 1 ? [`${attempts} attempts`] : []),
    ...(op.error === null ? [] : [`error: ${op.error.slice(0, 160)}`]),
  ]
  return { at: op.createdAt, text: parts.join('  ') }
}

/**
 * How far a join got: into the world, how long that took, or where it stopped. Only a server's
 * reporter tells of a login and times the way in. A server without one has its player list read
 * once a minute: a player on it was in the world by that reading, which says nothing of how long
 * the join took, and one not on it a minute or more after being handed over wasn't yet. A join no
 * reading caught says how much came back through the edge, which is all that was seen of it.
 */
function reachedOf(join: JoinView): string {
  if (join.inWorldAt !== null) return `in the world in ${secondsBetween(join.connectedAt, join.inWorldAt)}s`
  const listedAt = join.listedAt ?? null
  if (listedAt !== null) return `in the world, on its player list by ${clock(listedAt)}`
  if (join.loginAt !== null) return 'logged in, never in the world'
  if (join.handedAt === null) return 'not handed to the server'
  if (join.serverSide === 'reported') return 'never logged in'
  const back = join.bytesDown === null ? '' : `, ${join.bytesDown} bytes back`
  const notListedAt = join.notListedAt ?? null
  if (notListedAt !== null)
    return `handed to the server, not on its player list at ${clock(notListedAt)}${back}`
  return `handed to the server, which reports no login${back}`
}

/** How a join's session ended, with the edge's word on it where it gave one. */
function endOf(join: JoinView): string {
  if (join.leftAt === null) return 'still on'
  const why = join.leftReason === null ? '' : ` (${join.leftReason})`
  const session = join.detail.session as
    | { closedFirst?: string; how?: string; quietAtEndMs?: number }
    | undefined
  if (session === undefined) return `left ${clock(join.leftAt)}${why}`
  const quiet =
    session.quietAtEndMs === undefined ? '' : `, player quiet ${Math.round(session.quietAtEndMs / 1000)}s`
  return `left ${clock(join.leftAt)}${why}, ${session.how ?? 'closed'} by the ${session.closedFirst ?? 'unknown'} side${quiet}`
}

/** How a join went in a line: who, how far, and how its session ended where the edge said. */
function joinLine(join: JoinView): Line {
  const who = join.playerName ?? (join.kind === 'look' ? 'a server-list look' : 'someone')
  const went = join.kind === 'look' ? '' : `${reachedOf(join)}; ${endOf(join)}`
  const wake = join.wakeOperationId === null ? '' : '  woke it'
  return { at: join.connectedAt, text: `${join.kind.padEnd(6)} ${who}  ${went}${wake}`.trimEnd() }
}

/** A signal in a line: its kind and what it found. */
function signalLine(signal: SignalView): Line {
  const { server: _server, ...detail } = signal.detail
  const said = Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join(' ')
  return {
    at: signal.at,
    text: `signal ${signal.kind}  ${said}${signal.closedAt === null ? '' : '  (closed)'}`.trimEnd(),
  }
}

/** The server's operations, joins and signals, oldest first, a line each, under its name. */
export function timelineReport(input: {
  server: { name: string; slug: string; id: string }
  operations: readonly OperationStepsView[]
  joins: readonly JoinView[]
  signals: readonly SignalView[]
}): string {
  const lines = [
    ...input.operations.map(operationLine),
    ...input.joins.map(joinLine),
    ...input.signals.map(signalLine),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const head = `${input.server.name} (${input.server.slug}, ${input.server.id})`
  if (lines.length === 0) return `${head}\n  nothing in this window`
  return [head, ...lines.map((line) => `  ${line.at.slice(0, 10)} ${clock(line.at)}  ${line.text}`)].join(
    '\n',
  )
}
