// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the public endpoints answer, as much of it as a preview needs. */
export interface PublicStatus {
  name: string
  description: string
  address: string
  state: 'awake' | 'asleep'
  players: { online: number; max: number }
  minecraft: { edition: string; version: string; serverType: string }
  whitelistOnly: boolean
  /** The pack players install to join; null when plain Minecraft joins. Absent from older answers. */
  pack?: { name: string; version: string } | null
}

/** What an invite says a friend needs first: "You need Cobblemon 1.8.1", or nothing. */
export const needsLine = (status: PublicStatus): string | null =>
  status.pack ? `You need ${status.pack.name} ${status.pack.version} in your own game.` : null

export const playingLine = (status: PublicStatus): string =>
  status.state === 'awake'
    ? `${status.players.online} of ${status.players.max} playing right now`
    : 'Asleep — it wakes up when someone joins'

export const runsLine = (status: PublicStatus): string =>
  `Minecraft ${status.minecraft.version}${
    status.minecraft.serverType === 'vanilla' ? '' : ` · ${status.minecraft.serverType}`
  }`

import { InviteCode } from '@blockly/contracts'
import { headers } from 'next/headers'
import { apiUpstream } from '../../lib/upstream'

/**
 * A link preview is read by somebody else's server, so what it points at has to be an address
 * the whole internet can open. The request's own host is that address, whatever origin this
 * deployment answers on, which is one fewer thing to configure.
 */
export async function publicUrl(path: string): Promise<string> {
  const head = await headers()
  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:3000'
  const protocol = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${protocol}://${host}${path}`
}

/**
 * What a public read answered: the status; `missing` where there is nothing to show (a server
 * that isn't public, an invite that doesn't work); `unanswered` where Blockly couldn't say right
 * now, in a busy minute or while it can't be reached. A page knows nothing from the last, so it
 * says nothing about the server from it: never that an invite expired or a server is private.
 */
export type PublicRead = PublicStatus | 'missing' | 'unanswered'

async function read(path: string): Promise<PublicRead> {
  try {
    const response = await fetch(`${apiUpstream()}${path}`, { cache: 'no-store' })
    if (response.ok) return (await response.json()) as PublicStatus
    return response.status === 404 ? 'missing' : 'unanswered'
  } catch {
    return 'unanswered'
  }
}

/**
 * A public server's state, read the way anything outside Blockly reads it. Kept apart from the
 * pages so a link preview never drags a page's own code along with it.
 */
export const statusOf = (slug: string): Promise<PublicRead> =>
  read(`/api/public/servers/${encodeURIComponent(slug)}`)

/** The same, for what an invitation points at. */
export const invitedTo = (code: string): Promise<PublicRead> =>
  read(`/api/public/invites/${encodeURIComponent(code)}`)

/**
 * The invite code in a link as it was opened. Chat apps take the full stop or the bracket after a
 * link into it, so whatever can't be part of a code is dropped from either end. Null where what is
 * left still isn't a code, like a link cut off part way, so the page can say so without asking.
 */
export function inviteCodeOf(opened: string): string | null {
  let text = opened
  try {
    text = decodeURIComponent(opened)
  } catch {
    // A stray % is only more of what gets dropped.
  }
  const parsed = InviteCode.safeParse(text.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''))
  return parsed.success ? parsed.data : null
}
