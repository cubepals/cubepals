// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who made the Arcade's maps, as their licences ask to be told (`map-credits.ts`). Said twice from
 * the same facts: in the game, by `/trigger credits`, and in `CREDITS.txt` inside the world's
 * archive. Where each map is fetched from lives here too, since the credits link to the same place.
 * Not the maps' places in the world (`maps.ts`).
 */
import { MAP_PUBLISHERS } from '@blockly/contracts/published-maps'
import { type MapSource, mapLines, mapTexts } from '../map-credits.ts'
import { PAPER } from './datapack.ts'
import { ARCADE_MAPS } from './maps.ts'

/** NetherGames' worlds and the Overcast Community's maps, as the site credits them too. */
const { netherGames: NETHERGAMES, overcast: OVERCAST } = MAP_PUBLISHERS

/** Where each map is published, by its key in `ARCADE_MAPS`: the repository, the commit read, the folder. */
export const MAP_SOURCES: Readonly<Record<string, MapSource>> = {
  lobby: { ...NETHERGAMES, path: 'Lobby/worlds/ArcadeLobby' },
  meltdown: { ...NETHERGAMES, path: 'Meltdown/arenas/MD-Meltdown' },
  jungle: { ...OVERCAST, path: 'fun/arcade/parkour_jungle' },
  ice: { ...OVERCAST, path: 'fun/arcade/parkour_ice' },
  debris: { ...OVERCAST, path: 'fun/arcade/parkour_debris' },
  market: { ...OVERCAST, path: 'ffa/frozen_market' },
}

const SHARE_ALIKE =
  'Cubepals changed them to fit together, as each says. Its changes to the CC BY-SA maps are CC BY-SA 4.0 too.'

/** The credits as chat lines, in the game's text format: hover a map for what changed, click to open. */
export const CREDIT_LINES: readonly string[] = [
  `{text:"The Cubepals Arcade is made of these maps, each under its own licence:",color:"${PAPER}",bold:true}`,
  ...mapLines(ARCADE_MAPS, MAP_SOURCES),
  `{text:"${SHARE_ALIKE} Hover a map's name for what changed.",color:"gray"}`,
]

/** The credits as a text file, for the world's archive. */
export function creditsText(): string {
  return [
    'The Cubepals Arcade',
    '',
    'This world is made of the maps below, each under its own licence. NetherGames released its',
    'worlds under CC BY 4.0, and the Overcast Community its maps under CC BY-SA 4.0.',
    SHARE_ALIKE,
    'The Cubepals mark, lockup and the house at the spawn are Cubepals’ own and under neither licence.',
    '',
    ...mapTexts(ARCADE_MAPS, MAP_SOURCES).flatMap((text) => [text, '']),
  ].join('\n')
}
