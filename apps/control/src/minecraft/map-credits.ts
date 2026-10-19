// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crediting the published maps Cubepals' own servers are built from, as their licences ask: each
 * map's title, its builders, its licence with a link to it, a link to where it is published, and
 * what Cubepals changed (CC BY 4.0 and CC BY-SA 4.0, section 3(a)(1)). Each server's credits say
 * this in the game and in a file beside the maps, from the same facts: the Arcade's
 * (`arcade/credits.ts`) and the Duels lobby's (`duels-waiting/maps.ts`). Not which maps a server
 * uses, or where they sit.
 *
 * The links name Creative Commons and, through `MAP_PUBLISHERS`, GitHub: a licence's own address
 * and a map's source, never a deployment's, which the boundary check allows in this file alone.
 */
import { INDIGO } from './arcade/datapack.ts'

type Block = readonly [number, number, number]

export type Licence = 'CC BY 4.0' | 'CC BY-SA 4.0'

/** A published map, as Cubepals takes it into a world. */
export interface PublishedMap {
  /** The build's name for it. */
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
  /** Added to every block's position where it is placed. */
  offset: Block
  /** What Cubepals uses it for. */
  role: string
  /** What Cubepals changed in it, as its licence asks to be told. */
  changes: readonly string[]
}

/** Where a map is published: the repository, the commit read, the folder. */
export interface MapSource {
  repo: string
  commit: string
  path: string
}

/** Each licence by its full name, as Creative Commons gives it, and its address. */
export const LICENCES: Record<Licence, { name: string; url: string }> = {
  'CC BY 4.0': {
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  'CC BY-SA 4.0': {
    name: 'Creative Commons Attribution-ShareAlike 4.0 International',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  },
}

/** The map's folder at the commit read, as a page anyone can open. */
const sourceUrl = (map: PublishedMap, sources: Readonly<Record<string, MapSource>>): string => {
  const source = sources[map.key]
  if (source === undefined) throw new Error(`No source for the map ${map.key}`)
  return `${source.repo}/tree/${source.commit}/${source.path}`
}

/** Who built a map, and who published it where that is someone else. */
const byWhom = (map: PublishedMap): string =>
  map.builders.join(', ') + (map.builders.join() === map.publisher ? '' : `, published by ${map.publisher}`)

/** Each map as a chat line, in the game's text format: hover its name for what changed, click to open. */
export const mapLines = (
  maps: readonly PublishedMap[],
  sources: Readonly<Record<string, MapSource>>,
): string[] =>
  maps.map((map) => {
    const changes = JSON.stringify(`Changed by Cubepals:\n- ${map.changes.join('\n- ')}`)
    const link = (text: string, url: string) =>
      `{text:"${text}",color:"${INDIGO}",underlined:true,click_event:{action:"open_url",url:"${url}"}}`
    return `["",{text:"${map.title}",bold:true,hover_event:{action:"show_text",value:${changes}}},{text:" (${map.role}) by ${byWhom(map)}, ${map.licence}: ",color:"gray"},${link('licence', LICENCES[map.licence].url)},{text:" · ",color:"gray"},${link('source', sourceUrl(map, sources))}]`
  })

/** Each map as a paragraph of a credits file. */
export const mapTexts = (
  maps: readonly PublishedMap[],
  sources: Readonly<Record<string, MapSource>>,
): string[] =>
  maps.map((map) =>
    [
      `${map.title} (${map.role})`,
      `  By ${byWhom(map)}.`,
      `  Licence: ${LICENCES[map.licence].name} (${map.licence}), ${LICENCES[map.licence].url}`,
      `  Source: ${sourceUrl(map, sources)}`,
      '  Changed by Cubepals:',
      ...map.changes.map((change) => `  - ${change}`),
    ].join('\n'),
  )

/** A map's place where it is placed: a position in the map, moved by its offset. */
export function placedIn(maps: readonly PublishedMap[], key: string, [x, y, z]: Block): Block {
  const map = maps.find((m) => m.key === key)
  if (map === undefined) throw new Error(`No map ${key}`)
  return [x + map.offset[0], y + map.offset[1], z + map.offset[2]]
}
