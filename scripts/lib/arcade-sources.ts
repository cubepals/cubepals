// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where each of the Arcade's maps (`minecraft/arcade/maps.ts`) is published, as `arcade-world.ts`
 * fetches it: the repository, the commit the build reads, the map's folder there, and which
 * edition of Minecraft it was saved by. Each repository's licence file is at that commit's root.
 */

export interface MapSource {
  repo: string
  commit: string
  path: string
  edition: 'bedrock' | 'java'
}

/** NetherGames' worlds, released under CC BY 4.0. */
const NETHERGAMES = {
  repo: 'https://github.com/NetherGamesMC/assets',
  commit: '5cfda13ef2873c3a048d4a665fe100d1d24542b1',
}
/** The Overcast Community's maps, each folder with its CC BY-SA 4.0 licence. */
const OVERCAST = {
  repo: 'https://github.com/OvercastCommunity/PublicMaps',
  commit: '36dc0c21821b40bf014b8686013bdfdaf930f95d',
}

/** By the map's key in `ARCADE_MAPS`. */
export const MAP_SOURCES: Readonly<Record<string, MapSource>> = {
  lobby: { ...NETHERGAMES, path: 'Lobby/worlds/ArcadeLobby', edition: 'bedrock' },
  meltdown: { ...NETHERGAMES, path: 'Meltdown/arenas/MD-Meltdown', edition: 'bedrock' },
  jungle: { ...OVERCAST, path: 'fun/arcade/parkour_jungle', edition: 'java' },
  ice: { ...OVERCAST, path: 'fun/arcade/parkour_ice', edition: 'java' },
  debris: { ...OVERCAST, path: 'fun/arcade/parkour_debris', edition: 'java' },
  market: { ...OVERCAST, path: 'ffa/frozen_market', edition: 'java' },
}
