// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the provider's proxy said around a session that was cut off between its player and the edge
 * (`dropped`, `signal-kinds.ts`): its lines from just before the player's side went quiet for the
 * last time to just after the session ended, kept on the signal beside what the edge saw. The edge only knows that
 * nothing more came from the player; the provider's proxy carried the connection in, and what it
 * wrote, or that it wrote nothing, says which side of it the break was on. Addresses are taken out
 * of its lines: a signal names a server and a player, never where they connect from.
 */
import { isIPv6 } from 'node:net'
import { SECOND_MS } from '@blockly/contracts/durations'
import type { LogLine } from '../ports/platform.ts'

/** One line of the provider's proxy, as a signal keeps it. */
export interface ProviderLine {
  at: string
  said: string
}

/** How long before the quiet began the read starts: the proxy may write first. */
const BEFORE_MS = 5 * SECOND_MS
/** How long after the session ended it goes on: Fly's proxy wrote up to 8 s after (2026-11). */
const AFTER_MS = 30 * SECOND_MS
/** The most lines a signal keeps, and the most of each. */
const LINES = 5
const LENGTH = 300

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
/** A run of what an IPv6 address is written in, in brackets or not; `isIPv6` says whether it is one. */
const IPV6_RUN = /\[?[0-9a-f:.]{2,}\]?/gi
/** The longest an IPv6 address is written: eight groups, the last two as an IPv4 address. */
const IPV6_LENGTH = 45

/** A run without the IPv6 address it opens with, whatever form it is written in; itself when it has none. */
function withoutIpv6(run: string): string {
  const inner = run.replace(/^\[|\]$/g, '')
  if (inner.split(':').length < 3) return run
  for (let end = Math.min(inner.length, IPV6_LENGTH); end > 1; end--) {
    if (isIPv6(inner.slice(0, end))) return `<address>${inner.slice(end)}`
  }
  return run
}

/** A line without the addresses in it. */
const withoutAddresses = (text: string): string =>
  text.replace(IPV6_RUN, withoutIpv6).replace(IPV4, '<address>')

/** The moments to read between for a session that ended: from where its last quiet began, as the edge measured it. */
function saidBetween(session: {
  leftAt: Date | null
  detail: Record<string, unknown>
}): { from: Date; to: Date } | null {
  if (session.leftAt === null) return null
  const end = session.detail.session
  const measured =
    end !== null && typeof end === 'object' ? (end as Record<string, unknown>).quietAtEndMs : null
  // The quiet the session ended in, never an earlier, longer one the player came back from.
  const quietMs = typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? measured : 0
  const left = session.leftAt.getTime()
  return { from: new Date(left - quietMs - BEFORE_MS), to: new Date(left + AFTER_MS) }
}

/**
 * The provider's lines around the session's end, as a signal keeps them: none where its proxy
 * wrote none, and null where there is no such proxy to have written any.
 */
export async function providerSaid(
  said: (from: Date, to: Date) => Promise<LogLine[] | null>,
  session: { leftAt: Date | null; detail: Record<string, unknown> },
): Promise<ProviderLine[] | null> {
  const between = saidBetween(session)
  if (between === null) return null
  const lines = await said(between.from, between.to)
  if (lines === null) return null
  return lines
    .slice(-LINES)
    .map((line) => ({ at: line.at.toISOString(), said: withoutAddresses(line.text).slice(0, LENGTH) }))
}
