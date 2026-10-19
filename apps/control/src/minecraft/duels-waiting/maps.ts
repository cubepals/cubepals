// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The published maps the Duels lobby is made of: two parkour courses and an arena for the pit. Who
 * built each, under which licence, where it is published, what Cubepals changed, and where it sits
 * beside the void world's platform. Each reaches a server as a structure file in the waiting
 * datapack (`app/setups/duels-structures.ts`), which `scripts/duels-lobby.ts` builds from where the map is published
 * and which the datapack places as the world loads; the games read the same places, so a map that moves moves
 * for both. Its credits, as its licence asks, are said in the game by `/trigger credits` and in
 * `CREDITS.txt` in the datapack (`map-credits.ts`). Not the games' rules.
 *
 * Every map keeps its own licence. The Overcast Community's courses are CC BY-SA 4.0, so Cubepals'
 * changes to them, and their structure files, are CC BY-SA 4.0 too; NetherGames' arena is CC BY 4.0.
 */
import { MAP_PUBLISHERS } from '@blockly/contracts/published-maps'
import { RUNNING_LEVEL } from '../../domain/revision/carried.ts'
import type { Block } from '../arcade/datapack.ts'
import { type MapSource, mapLines, mapTexts, type PublishedMap, placedIn } from '../map-credits.ts'

/** The datapack's folder in the running world, and the name Minecraft lists it by. */
export const WAITING_DATAPACK = `${RUNNING_LEVEL}/datapacks/cubepals-duels`

/** The datapack's namespace: `cubepals:parkour/finish` is one of its functions. */
export const NS = 'cubepals'

export const DUELS_MAPS: readonly PublishedMap[] = [
  {
    key: 'ice',
    title: 'Parkour: Ice',
    name: 'Ice',
    builders: ['Crazy_', 'ViceTechnicolour'],
    publisher: 'Overcast Community',
    licence: 'CC BY-SA 4.0',
    from: [-130, 0, -19],
    to: [-98, 24, 10],
    offset: [83, -61, 8],
    role: 'parkour, first stage',
    changes: [
      'Converted to Java Edition 1.21.11 with Chunker and placed beside the Duels platform as a structure',
      'Run as the first of two stages against one clock',
      'The box observers watched from left out',
      'Its player heads replaced by skeleton skulls of the same shape, so no player’s head is shown',
      'Recoloured in Cubepals’ paper, ink and warm yellow: its blue wool and carpet yellow, its diamond block gold; its quartz, ice and fences as built',
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
    to: [2, 50, 8],
    offset: [-35, -61, -30],
    role: 'parkour, last stage',
    changes: [
      'Converted to Java Edition 1.21.11 with Chunker and placed beside the Duels platform as a structure',
      'Run as the last of two stages against one clock',
      'Recoloured in Cubepals’ sand and warm yellow: its stone bricks, slabs, stairs and walls in sandstone of the same shapes, its diamond block gold; its bars and ladders as built',
    ],
  },
  {
    key: 'cramped',
    title: 'DLS-Cramped',
    name: 'Cramped',
    builders: ['PROP11TH'],
    publisher: 'NetherGames',
    licence: 'CC BY 4.0',
    from: [-22, 76, -22],
    to: [22, 99, 22],
    offset: [8, -139, -36],
    role: 'the pit',
    changes: [
      'Converted to Java Edition 1.21.11 with Chunker and placed beside the Duels platform as a structure (it was a Bedrock Edition world)',
      'Used as a pit where everyone fights everyone, entered from a pad by the platform',
      'Its concrete powder placed as concrete, so it stays where it was built',
      'Recoloured in Cubepals’ sand, paper, ink and warm yellow: its floor and walls in sandstone and quartz, its cyan terracotta yellow; its wood, coal and the shape of the build as built',
    ],
  },
]

/** The Overcast Community's maps and NetherGames' worlds, at the commits the Arcade reads too. */
const { netherGames: NETHERGAMES, overcast: OVERCAST } = MAP_PUBLISHERS

/** Where each map is published, by its key in `DUELS_MAPS`. */
export const DUELS_SOURCES: Readonly<Record<string, MapSource>> = {
  ice: { ...OVERCAST, path: 'fun/arcade/parkour_ice' },
  debris: { ...OVERCAST, path: 'fun/arcade/parkour_debris' },
  cramped: { ...NETHERGAMES, path: 'Duels/arenas/DLS-Cramped' },
}

/** A map's place beside the platform: a position in the map, moved to where the map sits. */
export const placed = (key: string, at: Block): Block => placedIn(DUELS_MAPS, key, at)

/** Placing a map where it sits: its structure's first corner at its box's first corner, moved. */
export const placeMap = (key: string): string => {
  const map = DUELS_MAPS.find((m) => m.key === key)
  if (map === undefined) throw new Error(`No Duels map ${key}`)
  return `place template ${NS}:${key} ${placed(key, map.from).join(' ')}`
}

const SHARE_ALIKE =
  'Cubepals changed them to fit beside the platform, as each says. Its changes to the CC BY-SA maps are CC BY-SA 4.0 too.'

/** The credits as chat lines, in the game's text format, shown by `/trigger credits`. */
export const CREDIT_LINES: readonly string[] = [
  '{text:"The Duels lobby is made of these maps, each under its own licence:",bold:true}',
  ...mapLines(DUELS_MAPS, DUELS_SOURCES),
  `{text:"${SHARE_ALIKE} Hover a map's name for what changed.",color:"gray"}`,
]

/** The credits as a text file, in the datapack beside the structures. */
export const CREDITS_TEXT = [
  'The Cubepals Duels lobby',
  '',
  'Its parkour and pit are made of the maps below, each under its own licence. The Overcast',
  'Community released its maps under CC BY-SA 4.0, and NetherGames its worlds under CC BY 4.0.',
  SHARE_ALIKE,
  'The Cubepals mark and its signs are Cubepals’ own and under neither licence.',
  '',
  ...mapTexts(DUELS_MAPS, DUELS_SOURCES).flatMap((text) => [text, '']),
].join('\n')
