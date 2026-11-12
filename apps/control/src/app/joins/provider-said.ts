// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the provider's proxy said around a session that was cut off between its player and the edge
 * (`dropped`, `signal-kinds.ts`): its lines from just before the player's side went quiet to just
 * after the session ended, kept on the signal beside what the edge saw. The edge only knows that
 * nothing more came from the player; the provider's proxy carried the connection in, and what it
 * wrote, or that it wrote nothing, says which side of it the break was on. Addresses are taken out
 * of its lines: a signal names a server and a player, never where they connect from.
 */
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
const IPV6 = /\[?\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){3,7}\b\]?/gi

/** A line without the addresses in it. */
const withoutAddresses = (text: string): string => text.replace(IPV4, '<address>').replace(IPV6, '<address>')

/** The moments to read between for a session that ended: from where its last quiet began, where the edge said. */
function saidBetween(session: {
  leftAt: Date | null
  detail: Record<string, unknown>
}): { from: Date; to: Date } | null {
  if (session.leftAt === null) return null
  const end = session.detail.session
  const quietFrom =
    end !== null && typeof end === 'object'
      ? Date.parse(String((end as Record<string, unknown>).longestQuietFrom ?? ''))
      : Number.NaN
  const from =
    Number.isNaN(quietFrom) || quietFrom > session.leftAt.getTime() ? session.leftAt.getTime() : quietFrom
  return { from: new Date(from - BEFORE_MS), to: new Date(session.leftAt.getTime() + AFTER_MS) }
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
