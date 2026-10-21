// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stop cheaters, as the API takes and shows it: the switch on the Players page, why Cubepals turned
 * it on, and the players it removed, each with what a removed player reads.
 */
import { z } from 'zod'
import { ServerId } from './server.ts'

/** Why a player was removed, as Grim's punishments name it to the reporter's command. */
export const REMOVAL_REASONS = ['movement', 'speed', 'impossible'] as const
export type RemovalReason = (typeof REMOVAL_REASONS)[number]

/** What a removed player reads as they are kicked, and the Players page says of them. */
export const REMOVAL_MESSAGES: Readonly<Record<RemovalReason, string>> = {
  movement: 'Removed for moving in a way the game can’t. You can rejoin.',
  speed: 'Removed for moving faster than the game allows. You can rejoin.',
  impossible: 'Removed for sending something the game can’t. You can rejoin.',
}

/** The owner's setting: Cubepals' default (`auto`), or their own choice. */
export type StopCheatersSetting = 'auto' | 'on' | 'off'

export interface RemovalView {
  player: { uuid: string; name: string }
  reason: RemovalReason
  at: string
}

export interface StopCheatersView {
  /** Whether it runs at the server's next start. */
  effective: boolean
  setting: StopCheatersSetting
  /** Why Cubepals turned it on, where the owner didn't: publishing, the template, or the server being official. */
  why: 'browse' | 'template' | 'official' | null
  /** Its last boot left the owner's own Grim settings in place. */
  own: boolean
  /**
   * `yes` where it runs; `modded` on a server type it can't; `release` where Grim has no build for
   * the server's Minecraft yet, with the release named.
   */
  available: { kind: 'yes' } | { kind: 'modded' } | { kind: 'release'; release: string }
  /** The newest 20, newest first. */
  removals: RemovalView[]
  /** How many of them were today, in the server's day as UTC. */
  today: number
}

export const SetStopCheatersInput = z.object({ serverId: ServerId, on: z.boolean(), requestId: z.uuid() })

/** Put Cubepals' punishments back in place of the owner's own Grim settings. */
export const UseOurStopCheatersInput = z.object({ serverId: ServerId, requestId: z.uuid() })
