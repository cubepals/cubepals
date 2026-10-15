// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The published maps the Arcade's world is made of: who built each, under which licence, and where
 * it sits in the Arcade's world. The world is built once from these by `scripts/arcade-world.ts`,
 * which also knows where each is published (`scripts/lib/arcade-sources.ts`), and reaches a server
 * as an archive (`ARCADE_WORLD`); the datapack's games read the same places, so a map that moves
 * moves for both. Not the games' rules.
 *
 * Every map keeps its own licence. NetherGames' are CC BY 4.0. Overcast's are CC BY-SA 4.0, so
 * Cubepals' changes to those maps, and the parts of the world made from them, are CC BY-SA 4.0 too.
 */
import type { ModArtifact } from '../../domain/mods/artifact.ts'
import type { Block } from './datapack.ts'

export type Licence = 'CC BY 4.0' | 'CC BY-SA 4.0'

/** Each licence by its full name, as Creative Commons gives it. */
export const LICENCE_NAMES: Record<Licence, string> = {
  'CC BY 4.0': 'Creative Commons Attribution 4.0 International',
  'CC BY-SA 4.0': 'Creative Commons Attribution-ShareAlike 4.0 International',
}

export interface ArcadeMap {
  /** The build's name for it, and its dimension's while the world is built. */
  key: string
  /** As its authors published it. */
  title: string
  /** Who built it, as its source names them. */
  builders: readonly string[]
  /** Who published it under its licence. */
  publisher: string
  licence: Licence
  /** The box of blocks the build takes from it, both corners included, as the map has them. */
  from: Block
  to: Block
  /** Added to every block's position in the Arcade's world. */
  offset: Block
  /** What the Arcade uses it for. */
  role: string
}

export const ARCADE_MAPS: readonly ArcadeMap[] = [
  {
    key: 'lobby',
    title: 'ArcadeLobby',
    builders: ['NetherGames'],
    publisher: 'NetherGames',
    licence: 'CC BY 4.0',
    from: [100, 1, 1340],
    to: [256, 119, 1460],
    offset: [0, 0, 0],
    role: 'the hub',
  },
  {
    key: 'meltdown',
    title: 'MD-Meltdown',
    builders: ['NetherGames'],
    publisher: 'NetherGames',
    licence: 'CC BY 4.0',
    from: [-160, 26, -160],
    to: [161, 166, 161],
    offset: [0, 0, 0],
    role: 'the falling floor',
  },
  {
    key: 'jungle',
    title: 'Parkour: Jungle',
    builders: ['Crazy_', 'ViceTechnicolour', 'Tywnis'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-31, 0, -33],
    to: [8, 32, 19],
    offset: [1000, 64, 0],
    role: 'parkour, first stage',
  },
  {
    key: 'ice',
    title: 'Parkour: Ice',
    builders: ['Crazy_', 'ViceTechnicolour'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-130, 0, -19],
    to: [-98, 36, 39],
    offset: [1300, 64, 0],
    role: 'parkour, second stage',
  },
  {
    key: 'debris',
    title: 'Parkour: Debris',
    builders: ['gobernment', 'ViceTechnicolour'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-17, 0, -3],
    to: [2, 48, 8],
    offset: [1400, 64, 0],
    role: 'parkour, last stage',
  },
  {
    key: 'market',
    title: 'Frozen Market',
    builders: ['_3Each'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-88, 1, -35],
    to: [-4, 23, 38],
    offset: [-1000, 64, 0],
    role: 'the pit',
  },
]

/** A map's place in the Arcade's world: a position in the map, moved to where the map sits. */
export function placed(key: string, [x, y, z]: Block): Block {
  const map = ARCADE_MAPS.find((m) => m.key === key)
  if (map === undefined) throw new Error(`No Arcade map ${key}`)
  return [x + map.offset[0], y + map.offset[1], z + map.offset[2]]
}

const ARCADE_WORLD_SHA512 =
  'd79036bcf720fb7d906e7190ca3f861adf83e23474a6aa9d13de88b0d7be88104dc1c210c1cd082d05f492612f40332636194a7f3c9d18e00bbef3a474ac2fab'

/**
 * The Arcade's world, as `scripts/arcade-world.ts` builds it from these maps: its overworld,
 * packed. It is kept in the archive store under its bytes, as a pack Blockly builds is
 * (`ingestFile`), never in this repository, and a server fetches it through its own link.
 */
export const ARCADE_WORLD: ModArtifact = {
  ref: { kind: 'stored', key: `artifacts/${ARCADE_WORLD_SHA512}` },
  sha512: ARCADE_WORLD_SHA512,
  sizeBytes: 3290867,
  fileName: 'arcade-world.tar.gz',
}
