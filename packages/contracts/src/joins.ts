// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which Minecraft versions can join a server, in the words every page uses for it: the share card,
 * the server page, an invite and the settings. One function, so no place names a version the others
 * don't. The range itself is `minecraft/clients.ts`'s in the control plane; this only words it.
 */

/** The oldest release whose players join, and whether newer ones do too. */
export interface JoinRange {
  oldest: string
  newer: boolean
}

/**
 * The versions that join a server on `gameVersion`: "1.21.11" alone, "1.9 or newer" where other
 * versions are let in. A range with an end and no "newer" is said "from 1.9 to 26.2".
 */
export function versionsThatJoin(gameVersion: string, joins: JoinRange | null): string {
  if (joins === null) return gameVersion
  if (joins.newer)
    return joins.oldest === gameVersion ? `${gameVersion} or newer` : `${joins.oldest} or newer`
  return joins.oldest === gameVersion ? gameVersion : `${joins.oldest} to ${gameVersion}`
}
