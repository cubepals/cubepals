// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who a player is to a server: the UUID and name a typed name stands for, a Bedrock player's by
 * their gamertag included, and whether a typed name names a player already known.
 */

import { createHash } from 'node:crypto'
import { floodgateName, floodgateUuid, isBedrockUuid, typedAsBedrock } from '@blockly/contracts'
import type { PlayerRef } from '../../domain/access/access.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { offlineIdentitySeed, uuidFromMd5 } from '../../minecraft/identity.ts'
import type { GeyserMc } from '../ports/geysermc.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'

/** The UUID a server that doesn't verify accounts gives the player who types this name. */
export const offlineUuid = (name: string): string =>
  uuidFromMd5(createHash('md5').update(offlineIdentitySeed(name), 'utf8').digest())

/** What Minecraft lets a Java account be called; anything else can only be a gamertag. */
const JAVA_NAME = /^[A-Za-z0-9_]{3,16}$/

/** Whether a name is one a Java account can have. */
export const isJavaName = (name: string): boolean => JAVA_NAME.test(name)

/**
 * The player a name means to a server: its Minecraft account where the server verifies accounts,
 * and otherwise the name itself, exactly as typed. Null where the server verifies accounts and
 * no account has the name. A name that starts with a dot, as Floodgate names Bedrock players, is
 * a Bedrock player whatever the server checks; so is a name no Minecraft account has, when an Xbox
 * account does, on either kind of server. Without `geyser`, no Bedrock player is found, and a name
 * that is not a Java name is no player.
 */
export async function identityFor(
  name: string,
  onlineMode: boolean,
  profiles: PlayerProfiles,
  geyser: Pick<GeyserMc, 'xuidOf'> | null,
): Promise<PlayerRef | null> {
  const typed = name.trim()
  if (typedAsBedrock(typed)) return bedrockPlayer(typed.slice(1), geyser)
  const offline = { uuid: offlineUuid(typed), name: typed }
  const profile = await javaProfile(typed, onlineMode, profiles)
  if (profile !== null)
    return onlineMode ? { uuid: normalizeUuid(profile.uuid), name: profile.name } : offline
  const bedrock = await bedrockPlayer(typed, geyser)
  // Only a Java name can be a player a server makes up from the name: any other, a gamertag with a
  // space say, would reach the server's commands as the Java player its first word names.
  return bedrock ?? (onlineMode || !JAVA_NAME.test(typed) ? null : offline)
}

/**
 * The Java profile called `typed`; null where none is, or the name is none Minecraft allows. A
 * server that doesn't verify accounts has no need of the answer, so where Mojang can't give it the
 * name stays a Java player's.
 */
async function javaProfile(typed: string, onlineMode: boolean, profiles: PlayerProfiles) {
  if (!JAVA_NAME.test(typed)) return null
  return onlineMode ? profiles.byName(typed) : profiles.byName(typed).catch(() => ({ uuid: '', name: typed }))
}

/** The Bedrock player with this gamertag, as Floodgate logs them in; null where no Xbox account is known by it. */
async function bedrockPlayer(
  gamertag: string,
  geyser: Pick<GeyserMc, 'xuidOf'> | null,
): Promise<PlayerRef | null> {
  const xuid = gamertag === '' || geyser === null ? null : await geyser.xuidOf(gamertag)
  return xuid === null ? null : { uuid: floodgateUuid(xuid), name: floodgateName(gamertag) }
}

/**
 * Whether an identity was made for this kind of server. An account's UUID is issued by Mojang
 * and never equals the one derived from a name, so the derived one gives the kind away. A Bedrock
 * player's is Floodgate's on either kind.
 */
export const keyedFor = (player: PlayerRef, onlineMode: boolean): boolean =>
  isBedrockUuid(player.uuid) || (normalizeUuid(player.uuid) === offlineUuid(player.name)) !== onlineMode

/**
 * Whether `typed` names this player, as an invitation or a list reads it: a Bedrock player by their
 * gamertag, with or without the dot, spaces or not; a Java player by their name, whatever its
 * capitals where the server verifies accounts. A plain name that a Java account could have is
 * never taken for a Bedrock player's.
 */
export function namedBy(player: PlayerRef, typed: string, onlineMode: boolean): boolean {
  if (!isBedrockUuid(player.uuid))
    return onlineMode ? player.name.toLowerCase() === typed.toLowerCase() : player.name === typed
  if (!typedAsBedrock(typed) && JAVA_NAME.test(typed)) return false
  const gamertag = typedAsBedrock(typed) ? typed.slice(1) : typed
  return floodgateName(gamertag).toLowerCase() === player.name.toLowerCase()
}
