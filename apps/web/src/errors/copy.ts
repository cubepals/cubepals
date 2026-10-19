// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What every error a visitor can meet says, so the 404, the app's error page, the root error and
 * the pages that stand in for the Worker and for Cloudflare (pages.ts) read as one voice. Each is
 * a title, a line that says it isn't the visitor's fault, and what to do next. Plain TypeScript:
 * the Worker's fallback imports this too, and it must not reach Next.
 */
import { OPERATOR } from '../legal/operator'

export type LostKind = 'notFound' | 'broken' | 'unavailable' | 'unreachable' | 'misrouted'

export const LOST: Record<LostKind, { status: number; title: string; line: string }> = {
  notFound: {
    status: 404,
    title: 'We can’t find that page',
    line: 'Not your fault. The link may be old, or we may have lost it in the move.',
  },
  broken: {
    status: 500,
    title: 'That page didn’t load',
    line: 'Not you, us. Something tripped on our side, and we’ve been told.',
  },
  unavailable: {
    status: 503,
    title: 'Cubepals is having a moment',
    line: 'Something is wrong on our side and we’re on it. It isn’t you.',
  },
  unreachable: {
    status: 502,
    title: 'Cubepals can’t be reached right now',
    line: 'That’s on us, not you. Something between you and our servers tripped.',
  },
  misrouted: {
    status: 530,
    title: 'Cubepals is pointed the wrong way for a moment',
    line: 'That’s on us, not you. Something in how our address finds us slipped, and we’re on it.',
  },
}

/** Where the visitor can reach us from any error. */
export const SUPPORT = OPERATOR.emails.support

/** The line under a failure of the whole site: game servers run apart from it. */
export const SERVERS_LINE = `Servers you’ve already made run apart from this site, so the address you have, like your-server.${OPERATOR.playDomain}, should keep working.`
