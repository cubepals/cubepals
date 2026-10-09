import { z } from 'zod'
import { ServerId } from './server.ts'

/**
 * Stars and short notes on public servers: a guestbook, never a community. A signed-in person
 * stars a server in one click, and leaves a note of a line; nothing replies, likes, sorts or
 * threads, and nobody has a profile. Notes are anonymous apart from "you" and "the owner".
 */

/** The most a note says, counted as a browser counts a text field (UTF-16 units). */
export const NOTE_MAX_LENGTH = 128

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

export interface NoteView {
  id: string
  body: string
  at: string
  /** Written by the person reading. */
  yours: boolean
  /** Written by the server's owner. */
  byOwner: boolean
  /** The person reading may delete it: its author, the server's owner, or an admin. */
  canDelete: boolean
}

/** The latest notes, newest first, and how many there are in all. */
export interface NotesView {
  notes: NoteView[]
  total: number
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
