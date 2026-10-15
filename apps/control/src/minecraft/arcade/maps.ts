// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The published maps the Arcade's world is made of: who built each, under which licence, and where
 * it sits in the Arcade's world. The world is built once from these by `scripts/arcade-world.ts`,
 * from where each is published (`credits.ts`), and reaches a server
 * as an archive (`ARCADE_WORLD`); the datapack's games read the same places, so a map that moves
 * moves for both. Not the games' rules.
 *
 * Every map keeps its own licence. NetherGames' are CC BY 4.0. Overcast's are CC BY-SA 4.0, so
 * Cubepals' changes to those maps, and the parts of the world made from them, are CC BY-SA 4.0 too.
 */
import type { ModArtifact } from '../../domain/mods/artifact.ts'
import type { Block } from './datapack.ts'

export type Licence = 'CC BY 4.0' | 'CC BY-SA 4.0'

export interface ArcadeMap {
  /** The build's name for it, and its dimension's while the world is built. */
  key: string
  /** As its authors published it. */
  title: string
  /** Its own name, short, as a sign at it says it: `Jungle`, not `Parkour: Jungle`. */
  name: string
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
  /** What Cubepals changed in it, as its licence asks to be told. */
  changes: readonly string[]
}

export const ARCADE_MAPS: readonly ArcadeMap[] = [
  {
    key: 'lobby',
    title: 'ArcadeLobby',
    name: 'ArcadeLobby',
    builders: ['NetherGames'],
    publisher: 'NetherGames',
    licence: 'CC BY 4.0',
    from: [100, 1, 1340],
    to: [256, 119, 1460],
    offset: [0, 0, 0],
    role: 'the hub',
    changes: [
      'Converted to Java Edition 26.2 with Chunker and moved into one world with the others (it was a Bedrock Edition world)',
      'Recoloured in Cubepals’ sand, paper, ink and yellow: the hall’s walls, ceiling, floor and trims; the cabinets and the shape of the build are as built',
      'The four figures in the display case under the balcony taken out',
      'A doorway opened at the end of the west corridor, onto a house added outside, which is Cubepals’ own',
      'Cubepals’ mark on its two big screens, its lockup over the ARCADE cabinet, a pad for each game, and light through the hall',
      'Its concrete powder placed as concrete of the same colour, so it stays where it was built',
    ],
  },
  {
    key: 'meltdown',
    title: 'MD-Meltdown',
    name: 'Meltdown',
    builders: ['NetherGames'],
    publisher: 'NetherGames',
    licence: 'CC BY 4.0',
    from: [-160, 26, -160],
    to: [161, 166, 161],
    offset: [0, 0, 0],
    role: 'the falling floor',
    changes: [
      'Converted to Java Edition 26.2 with Chunker and moved into one world with the others (it was a Bedrock Edition world)',
      'A pad to wait on at the lake’s edge, a Cubepals sign, and a copy of its floors out of sight, to put them back each round',
      'Its concrete powder placed as concrete of the same colour, so it stays where it was built',
    ],
  },
  {
    key: 'jungle',
    title: 'Parkour: Jungle',
    name: 'Jungle',
    builders: ['Crazy_', 'ViceTechnicolour', 'Tywnis'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-31, 0, -33],
    to: [8, 32, 19],
    offset: [1000, 64, 0],
    role: 'parkour, first stage',
    changes: [
      'Converted to Java Edition 26.2 with Chunker and moved into one world with the others',
      'Run as the first of three stages against one clock',
      'The statue of a player beside the finish taken out: its legs and body removed, and its shoulders and head made plain mossy stone, keeping the ladder and the finish',
      'Its player heads replaced by skeleton skulls of the same shape, so no player’s head is shown',
      'A Cubepals sign over the start',
    ],
  },
  {
    key: 'ice',
    title: 'Parkour: Ice',
    name: 'Ice',
    builders: ['Crazy_', 'ViceTechnicolour'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-130, 0, -19],
    to: [-98, 36, 39],
    offset: [1300, 64, 0],
    role: 'parkour, second stage',
    changes: [
      'Converted to Java Edition 26.2 with Chunker and moved into one world with the others',
      'Run as the second of three stages against one clock',
      'Its player heads replaced by skeleton skulls of the same shape, so no player’s head is shown',
    ],
  },
  {
    key: 'debris',
    title: 'Parkour: Debris',
    name: 'Debris',
    builders: ['gobernment', 'ViceTechnicolour'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-17, 0, -3],
    to: [2, 48, 8],
    offset: [1400, 64, 0],
    role: 'parkour, last stage',
    changes: [
      'Converted to Java Edition 26.2 with Chunker and moved into one world with the others',
      'Run as the last of three stages against one clock',
    ],
  },
  {
    key: 'market',
    title: 'Frozen Market',
    name: 'Frozen Market',
    builders: ['_3Each'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-88, 1, -35],
    to: [-4, 23, 38],
    offset: [-1000, 64, 0],
    role: 'the pit',
    changes: [
      'Converted to Java Edition 26.2 with Chunker and moved into one world with the others',
      'Used as a pit where everyone fights everyone',
      'Its player heads replaced by skeleton skulls of the same shape, so no player’s head is shown',
      'A Cubepals sign over the market',
    ],
  },
]

/** A map's place in the Arcade's world: a position in the map, moved to where the map sits. */
export function placed(key: string, [x, y, z]: Block): Block {
  const map = ARCADE_MAPS.find((m) => m.key === key)
  if (map === undefined) throw new Error(`No Arcade map ${key}`)
  return [x + map.offset[0], y + map.offset[1], z + map.offset[2]]
}

const ARCADE_WORLD_SHA512 =
  '390b9903e5d7269598cc69c7cf62969b8c34131265b9cdedc6695b6385d3b159834367c4fb9c1dbf3b533e0604c8c677c60c589b75d021da59ceca75fb6ce4ef'

/**
 * The Arcade's world, as `scripts/arcade-world.ts` builds it from these maps: its overworld,
 * packed. It is kept in the archive store under its bytes, as a pack Blockly builds is
 * (`ingestFile`), never in this repository, and a server fetches it through its own link.
 */
export const ARCADE_WORLD: ModArtifact = {
  ref: { kind: 'stored', key: `artifacts/${ARCADE_WORLD_SHA512}` },
  sha512: ARCADE_WORLD_SHA512,
  sizeBytes: 3263785,
  fileName: 'arcade-world.tar.gz',
}
