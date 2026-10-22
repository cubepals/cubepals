// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly asks GeyserMC's services: the Floodgate build a Paper server runs, and the Xbox user
 * id (XUID) behind a gamertag. Floodgate's Paper jar is published there and nowhere a catalog pins
 * it from (Modrinth holds only its Fabric and NeoForge ports; Hangar links to the same download).
 */

/** The Floodgate plugin jar a build publishes, checked against the hash GeyserMC lists for it. */
export interface FloodgateJar {
  /** As GeyserMC numbers it: `2.2.5`, build `141`. */
  version: string
  build: number
  fileName: string
  /** A permanent link to this build's jar. */
  url: string
  sha512: string
  sizeBytes: number
}

export interface GeyserMc {
  /** The newest Floodgate build for Paper; null when GeyserMC lists none. Throws when it can't be asked. */
  latestFloodgate(): Promise<FloodgateJar | null>
  /** The XUID (decimal digits) of the Xbox account with this gamertag; null where none is known. */
  xuidOf(gamertag: string): Promise<string | null>
}
