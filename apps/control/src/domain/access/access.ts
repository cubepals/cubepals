// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live administration: who can join, who operates the server, who is banned. Changed while the
 * server runs, never through a revision. Two writers exist — Blockly and in-game operators — and
 * the server's own files are the working copy both write to (docs/architecture.md §15.1).
 */

export interface PlayerRef {
  /** The identity. Names change hands; UUIDs do not. */
  uuid: string
  name: string
}

export type AccessList = 'whitelist' | 'operator' | 'ban'
export type EntryState = 'active' | 'pending_add' | 'pending_remove' | 'rejected'

export interface EntryDetails {
  level?: number
  bypassesPlayerLimit?: boolean
  reason?: string
  source?: string
  expiresAt?: string
}

export interface AccessEntry {
  list: AccessList
  player: PlayerRef
  state: EntryState
  origin: 'blockly' | 'game'
  details: EntryDetails
  error: string | null
}

export interface AccessRecord {
  whitelistEnabled: boolean
  /** A whitelist on/off change waiting for delivery. */
  whitelistEnabledPending: boolean | null
  /** True when the server's files cannot be trusted: a fresh or restored volume. */
  reseedRequired: boolean
  entries: AccessEntry[]
}

/** What the server's files say right now. */
export interface ObservedAccess {
  /**
   * Whether the running server checks players with Minecraft's account servers, as its own
   * properties say. It decides what identity a name has on it (§15.1).
   */
  onlineMode: boolean
  whitelistEnabled: boolean
  whitelist: PlayerRef[]
  operators: Array<PlayerRef & { level: number; bypassesPlayerLimit: boolean }>
  bans: Array<PlayerRef & { reason: string | null; source: string | null; expiresAt: string | null }>
  /** IP bans cannot work behind a shared edge; reconciliation clears any it finds. */
  ipBans: Array<{ ip: string }>
}

export type AccessCommand =
  | { type: 'whitelist_mode'; enabled: boolean }
  | { type: 'whitelist_add'; player: PlayerRef }
  | { type: 'whitelist_remove'; player: PlayerRef }
  | { type: 'op'; player: PlayerRef }
  | { type: 'deop'; player: PlayerRef }
  | { type: 'ban'; player: PlayerRef; reason: string | null }
  | { type: 'pardon'; player: PlayerRef }
  | { type: 'pardon_ip'; ip: string }
  /** The server reads its whitelist file again, which Blockly has just written. */
  | { type: 'whitelist_reload' }

export const entryKey = (list: AccessList, uuid: string) => `${list}:${uuid.toLowerCase()}`

export function newAccessRecord(): AccessRecord {
  return { whitelistEnabled: false, whitelistEnabledPending: null, reseedRequired: true, entries: [] }
}
