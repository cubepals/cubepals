// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the Arcade's maps are published, at the commit its world is built from: NetherGames'
 * worlds (CC BY 4.0) and the Overcast Community's maps (CC BY-SA 4.0). A server's page credits
 * them (`templates.ts`), and so do the world's build and its in-game credits
 * (`apps/control/src/minecraft/arcade/credits.ts`). Imports nothing, so anything may read it.
 */
export const MAP_PUBLISHERS = {
  netherGames: {
    repo: 'https://github.com/NetherGamesMC/assets',
    commit: '5cfda13ef2873c3a048d4a665fe100d1d24542b1',
  },
  overcast: {
    repo: 'https://github.com/OvercastCommunity/PublicMaps',
    commit: '36dc0c21821b40bf014b8686013bdfdaf930f95d',
  },
} as const
