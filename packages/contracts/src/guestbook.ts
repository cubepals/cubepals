// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import { NOTE_MAX_LENGTH } from './limits.ts'
import { ServerId } from './server.ts'

/**
 * Stars and short notes on public servers: a guestbook, never a community. A signed-in person
 * stars a server in one click, and leaves a note of a line; nothing replies, likes, sorts or
 * threads, and nobody has a profile. A note shows its writer's first name and last initial, beside
 * a small picture drawn from a seed; notes from before names were shown stay anonymous.
 */

/** The notes a popover shows: the latest few, never a page of them. */
export const NOTES_SHOWN = 6

/** A server's stars and notes, beside it wherever strangers find it. */
export interface ReactionsView {
  serverId: string
  stars: number
  /** The person reading starred it; always false for someone signed out. */
  starred: boolean
  notes: number
  /** The person reading owns it, and doesn't star their own server. */
  yours: boolean
}

/**
 * Every way a note writer's picture can be drawn. A style stays listed once anyone has it, so their
 * picture can always be drawn again; which styles new writers are given is the API's choice.
 */
export const AVATAR_STYLES = ['mark', 'identicon', 'pixel', 'bauhaus', 'minidenticon'] as const
export type AvatarStyle = (typeof AVATAR_STYLES)[number]

/**
 * A writer's picture: the style they were given the first time it was drawn, kept for good, and
 * what it is drawn from, a hash of who they are that tells nothing about them.
 */
export interface AvatarView {
  style: AvatarStyle
  seed: string
}

export interface NoteView {
  id: string
  body: string
  at: string
  /** Its writer as strangers read them, "Davi H."; null for a note left as anonymous or nameless. */
  author: string | null
  /** The writer's picture. Every anonymous note shares one. */
  avatar: AvatarView
  /** Written by the person reading. */
  yours: boolean
  /** Written by the server's owner. */
  byOwner: boolean
  /** The person reading may delete it: its author, the server's owner, or an admin. */
  canDelete: boolean
}

/** The latest notes, newest first, how many there are in all, and what the reader's own show. */
export interface NotesView {
  notes: NoteView[]
  total: number
  /** The name a note the reader leaves shows; null when their account has none to show. */
  signature: string | null
}

/** A star set on or off: setting, not toggling, so a retry or a double click changes nothing. */
export const StarInput = z.object({ serverId: ServerId, starred: z.boolean() })
export interface StarView {
  stars: number
  starred: boolean
}

export const NotesRef = z.object({ serverId: ServerId })
export const AddNoteInput = z.object({
  serverId: ServerId,
  body: z.string().trim().min(1).max(NOTE_MAX_LENGTH),
})
export const NoteRef = z.object({ noteId: z.uuid() })
