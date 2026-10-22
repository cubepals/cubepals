// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

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

/**
 * The player a name means to a server: its Minecraft account where the server verifies accounts,
 * and otherwise the name itself, exactly as typed. Null where the server verifies accounts and
 * no account has the name. A name that starts with a dot, as Floodgate names Bedrock players, is
 * a Bedrock player whatever the server checks; so is a name no Minecraft account has, when an Xbox
 * account does. Without `geyser`, no Bedrock player is found.
 */
export async function identityFor(
  name: string,
  onlineMode: boolean,
  profiles: PlayerProfiles,
  geyser: Pick<GeyserMc, 'xuidOf'> | null,
): Promise<PlayerRef | null> {
  const typed = name.trim()
  if (typedAsBedrock(typed)) return bedrockPlayer(typed.slice(1), geyser)
  if (!onlineMode) return { uuid: offlineUuid(typed), name: typed }
  const profile = await profiles.byName(typed)
  if (profile !== null) return { uuid: normalizeUuid(profile.uuid), name: profile.name }
  return bedrockPlayer(typed, geyser)
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
