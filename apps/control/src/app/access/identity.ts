// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import type { PlayerRef } from '../../domain/access/access.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { offlineIdentitySeed, uuidFromMd5 } from '../../minecraft/identity.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'

/** The UUID a server that doesn't verify accounts gives the player who types this name. */
export const offlineUuid = (name: string): string =>
  uuidFromMd5(createHash('md5').update(offlineIdentitySeed(name), 'utf8').digest())

/**
 * The player a name means to a server: its Minecraft account where the server verifies accounts,
 * and otherwise the name itself, exactly as typed. Null where the server verifies accounts and
 * no account has the name.
 */
export async function identityFor(
  name: string,
  onlineMode: boolean,
  profiles: PlayerProfiles,
): Promise<PlayerRef | null> {
  const typed = name.trim()
  if (!onlineMode) return { uuid: offlineUuid(typed), name: typed }
  const profile = await profiles.byName(typed)
  return profile === null ? null : { uuid: normalizeUuid(profile.uuid), name: profile.name }
}

/**
 * Whether an identity was made for this kind of server. An account's UUID is issued by Mojang
 * and never equals the one derived from a name, so the derived one gives the kind away.
 */
export const keyedFor = (player: PlayerRef, onlineMode: boolean): boolean =>
  (normalizeUuid(player.uuid) === offlineUuid(player.name)) !== onlineMode
