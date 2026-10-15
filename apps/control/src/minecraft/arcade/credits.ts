// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who made the Arcade's maps, as their licences ask to be told: each map's title, its builders,
 * its licence with a link to it, a link to where it is published, and what Cubepals changed
 * (CC BY 4.0 and CC BY-SA 4.0, section 3(a)(1)). Said twice from the same facts: in the game, by
 * `/trigger credits`, and in `CREDITS.txt` inside the world's archive. Where each map is fetched
 * from lives here too, since the credits link to the same place. Not the maps' places in the world
 * (`maps.ts`).
 *
 * The links name Creative Commons and, through `MAP_PUBLISHERS`, GitHub: a licence's own address
 * and a map's source, never a deployment's, which the boundary check allows in this file alone.
 */
import { MAP_PUBLISHERS } from '@blockly/contracts/published-maps'
import { INDIGO, PAPER } from './datapack.ts'
import { ARCADE_MAPS, type ArcadeMap, type Licence } from './maps.ts'

/** Each licence by its full name, as Creative Commons gives it, and its address. */
const LICENCES: Record<Licence, { name: string; url: string }> = {
  'CC BY 4.0': {
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  'CC BY-SA 4.0': {
    name: 'Creative Commons Attribution-ShareAlike 4.0 International',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  },
}

export interface MapSource {
  repo: string
  commit: string
  path: string
}

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

/** The map's folder at the commit read, as a page anyone can open. */
const sourceUrl = (map: ArcadeMap): string => {
  const source = MAP_SOURCES[map.key]
  if (source === undefined) throw new Error(`No source for the Arcade map ${map.key}`)
  return `${source.repo}/tree/${source.commit}/${source.path}`
}

/** Who built a map, and who published it where that is someone else. */
const byWhom = (map: ArcadeMap): string =>
  map.builders.join(', ') + (map.builders.join() === map.publisher ? '' : `, published by ${map.publisher}`)

const SHARE_ALIKE =
  'Cubepals changed them to fit together, as each says. Its changes to the CC BY-SA maps are CC BY-SA 4.0 too.'

/** The credits as chat lines, in the game's text format: hover a map for what changed, click to open. */
export const CREDIT_LINES: readonly string[] = [
  `{text:"The Cubepals Arcade is made of these maps, each under its own licence:",color:"${PAPER}",bold:true}`,
  ...ARCADE_MAPS.map((map) => {
    const changes = JSON.stringify(`Changed by Cubepals:\n- ${map.changes.join('\n- ')}`)
    const link = (text: string, url: string) =>
      `{text:"${text}",color:"${INDIGO}",underlined:true,click_event:{action:"open_url",url:"${url}"}}`
    return `["",{text:"${map.title}",bold:true,hover_event:{action:"show_text",value:${changes}}},{text:" (${map.role}) by ${byWhom(map)}, ${map.licence}: ",color:"gray"},${link('licence', LICENCES[map.licence].url)},{text:" · ",color:"gray"},${link('source', sourceUrl(map))}]`
  }),
  `{text:"${SHARE_ALIKE} Hover a map's name for what changed.",color:"gray"}`,
]

/** The credits as a text file, for the world's archive. */
export function creditsText(): string {
  const maps = ARCADE_MAPS.map((map) =>
    [
      `${map.title} (${map.role})`,
      `  By ${byWhom(map)}.`,
      `  Licence: ${LICENCES[map.licence].name} (${map.licence}), ${LICENCES[map.licence].url}`,
      `  Source: ${sourceUrl(map)}`,
      '  Changed by Cubepals:',
      ...map.changes.map((change) => `  - ${change}`),
    ].join('\n'),
  )
  return [
    'The Cubepals Arcade',
    '',
    'This world is made of the maps below, each under its own licence. NetherGames released its',
    'worlds under CC BY 4.0, and the Overcast Community its maps under CC BY-SA 4.0.',
    SHARE_ALIKE,
    'The Cubepals mark, lockup and the house at the spawn are Cubepals’ own and under neither licence.',
    '',
    ...maps.flatMap((text) => [text, '']),
  ].join('\n')
}
