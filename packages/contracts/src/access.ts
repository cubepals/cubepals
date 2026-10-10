// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import { ServerId } from './server.ts'

export const ACCESS_LISTS = ['whitelist', 'operator', 'ban'] as const
export type AccessList = (typeof ACCESS_LISTS)[number]

/** A Minecraft Java name: 3–16 of letters, digits and underscore. */
export const PlayerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,16}$/, 'Minecraft names are 3 to 16 letters, numbers or underscores')

export const AddPlayerInput = z.object({ serverId: ServerId, name: PlayerName })
export const PlayerInput = z.object({ serverId: ServerId, playerUuid: z.uuid() })
export const BanInput = z.object({
  serverId: ServerId,
  name: PlayerName,
  reason: z.string().trim().max(120).optional(),
})
export const WhitelistModeInput = z.object({ serverId: ServerId, enabled: z.boolean() })

export interface AccessEntryView {
  list: AccessList
  player: { uuid: string; name: string }
  state: 'active' | 'pending_add' | 'pending_remove' | 'rejected'
  origin: 'blockly' | 'game'
  error: string | null
  reason: string | null
}

export interface AccessView {
  whitelistEnabled: boolean
  /** A change waiting for the server to be running. */
  pendingWhitelistEnabled: boolean | null
  entries: AccessEntryView[]
  syncedAt: string | null
  syncError: string | null
  version: number
  /**
   * IP bans made in game and lifted by Blockly lately, newest first: behind the shared edge an IP
   * ban would lock everyone out, so the owner is told why theirs is gone (§15.1).
   */
  liftedIpBans: { ip: string; at: string }[]
  /**
   * People who have played on the server, so naming one needs no typing: whoever is on now first,
   * then the most recently seen, each name once and at most 50. Offered, never trusted: a name
   * here is as the server or the edge reported it.
   */
  players: { name: string; uuid: string; online: boolean }[]
}
