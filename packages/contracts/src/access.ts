// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's access lists, as the API takes and shows them: who may join (the whitelist), who is
 * an operator and who is banned, each by their Minecraft name; and who Stop cheaters leaves
 * unchecked (`unchecked`).
 */

import { z } from 'zod'
import { PLAYER_NAME_MAX_LENGTH, PLAYER_NAME_MIN_LENGTH } from './limits.ts'
import { ServerId } from './server.ts'

export const ACCESS_LISTS = ['whitelist', 'operator', 'ban', 'helper', 'unchecked'] as const
export type AccessList = (typeof ACCESS_LISTS)[number]

/** A Minecraft Java name: letters, digits and underscore, as long as Mojang allows. */
export const PlayerName = z
  .string()
  .trim()
  .regex(
    new RegExp(`^[A-Za-z0-9_]{${PLAYER_NAME_MIN_LENGTH},${PLAYER_NAME_MAX_LENGTH}}$`),
    `Minecraft names are ${PLAYER_NAME_MIN_LENGTH} to ${PLAYER_NAME_MAX_LENGTH} letters, numbers or underscores`,
  )

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
