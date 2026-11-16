// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What each plate's top shows, in blocks on the plate (`u` along its right-hand side, `v` toward
 * its near left, both 0 to 16), and the line under each part's name. Drawn with the landing's own
 * server (sections/drawn.ts): its ways to play, its address, its example day; and with how many
 * sessions the plans keep. The near corner shows even when the stack is closed, so what matters
 * most sits toward it. Not where a plate is, which is geometry.ts.
 */
import { ADDRESS, DAY, hoursOn, SHOWN } from '../sections/drawn'
import { type Part, type Plate, widthOf } from './geometry'

/** How a box is filled: not at all, as what was picked, or as a track something runs along. */
type Fill = 'none' | 'picked' | 'track'

/** One mark on a plate's top. Words `on` a picked box are drawn in its reverse. */
export type Mark =
  | {
      kind: 'box'
      at: readonly [number, number, number, number]
      fill: Fill
      outline: 'solid' | 'dashed' | 'none'
    }
  | { kind: 'tick'; at: readonly [number, number, number, number] }
  | { kind: 'words'; text: string; u: number; v: number; size: number; fit?: number; on?: boolean }
  | { kind: 'face'; name: string; u: number; v: number; size: number }

/** What the tops are drawn from: the plan with mods, if any, and how many sessions the plans keep at most. */
export interface Told {
  plus: string | null
  kept: number
}

/**
 * The friends the drawn door has let in, each drawn with the face the players page gives their
 * name (`ui/face.tsx`): three names whose faces differ.
 */
const FRIENDS = ['kai', 'leo', 'mia'] as const
const ADDED = FRIENDS.length

/** How tall a friend's name is, in blocks, and how wide each of its letters, in a monospaced face. */
const NAME = 0.56
const LETTER = NAME * 0.6

const box = (
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  fill: Fill,
  outline: 'solid' | 'dashed' | 'none' = 'solid',
): Mark => ({
  kind: 'box',
  at: [u0, v0, u1, v1],
  fill,
  outline,
})
const words = (
  text: string,
  u: number,
  v: number,
  size: number,
  more: { fit?: number; on?: boolean } = {},
): Mark => ({
  kind: 'words',
  text,
  u,
  v,
  size,
  ...more,
})

/** Six of the ways to play, two rows of three, the first picked and nearest; a whole modpack behind them. */
function game({ plus }: Told): Mark[] {
  const tile = 4.5
  const step = tile + 0.35
  const nearest = [
    [2, 1],
    [1, 1],
    [2, 0],
    [0, 1],
    [1, 0],
    [0, 0],
  ] as const
  const marks: Mark[] = []
  SHOWN.slice(0, nearest.length).forEach((way, index) => {
    const [column, row] = nearest[index] as readonly [number, number]
    const u = 0.9 + column * step
    const v = 6 + row * step
    const picked = index === 0
    marks.push(box(u, v, u + tile, v + tile, picked ? 'picked' : 'none'))
    const size = 0.72
    marks.push(
      words(way.title, u + 0.5, v + tile / 2 + 0.26, size, {
        fit: Math.min(widthOf(way.title, size), tile - 1),
        on: picked,
      }),
    )
  })
  const modpack = `or a whole modpack${plus ? `, on ${plus}` : ''}`
  marks.push(words(modpack, 0.9, 3.6, 0.78, { fit: Math.min(widthOf(modpack, 0.78), 14.2) }))
  return marks
}

/** The example day along a track of 24 hours, with its hours run and slept behind it. */
function power(): Mark[] {
  const from = 1
  const across = 14
  const hour = (h: number) => from + (h / 24) * across
  const marks: Mark[] = [box(from, 6.4, from + across, 11.4, 'track')]
  for (const part of DAY) marks.push(box(hour(part.from), 6.4, hour(part.to), 11.4, 'picked', 'none'))
  for (let h = 0; h <= 24; h += 3)
    marks.push({ kind: 'tick', at: [hour(h), 11.4, hour(h), h % 6 === 0 ? 12.6 : 12] })
  for (let h = 0; h <= 24; h += 6) marks.push(words(String(h).padStart(2, '0'), hour(h) - 0.43, 14, 0.72))
  marks.push(words(`running ${hoursOn} h · asleep ${24 - hoursOn} h`, from, 3.6, 0.72))
  return marks
}

/** The address along the near edge, the friends let in, and who may come in, at the back. */
function door(): Mark[] {
  const marks: Mark[] = [words(ADDRESS, 1.2, 14.75, 0.86, { fit: 13.6 })]
  for (let i = 0; i < 5; i++) {
    const u = 1.2 + i * 2.8
    const friend = FRIENDS[i]
    marks.push(box(u, 9.7, u + 2.2, 12.5, 'none', friend ? 'solid' : 'dashed'))
    if (!friend) continue
    marks.push({ kind: 'face', name: friend, u: u + 0.4, v: 9.95, size: 1.4 })
    marks.push(words(friend, u + 1.1 - (friend.length * LETTER) / 2, 12.2, NAME))
  }
  const who = ['anyone with the address', 'only the people you add']
  who.forEach((text, k) => {
    const v = 2.3 + k * 2.2
    marks.push(box(1.2, v - 0.95, 2.15, v, k === 1 ? 'picked' : 'none'))
    marks.push(words(text, 2.8, v - 0.12, 0.72))
  })
  return marks
}

/** One square for each session kept, the newest last, and the copy kept before what can't be undone. */
function backups({ kept }: Told): Mark[] {
  const pitch = 14 / kept
  const marks: Mark[] = []
  for (let i = 0; i < kept; i++) {
    const u = 1 + i * pitch
    marks.push(box(u, 12.7, u + pitch * 0.76, 15, i === kept - 1 ? 'picked' : 'none'))
  }
  marks.push(words(`last ${kept} sessions`, 1, 12, 0.72))
  marks.push(words('+ a copy before anything', 1, 8.3, 0.72))
  marks.push(words('that can’t be undone', 1.86, 9.4, 0.72))
  return marks
}

export function topMarks(plate: Plate, told: Told): Mark[] {
  switch (plate) {
    case 'game':
      return game(told)
    case 'power':
      return power()
    case 'door':
      return door()
    case 'backups':
      return backups(told)
  }
}

/** The line under each part's name: what its top shows. */
export const NOTES: Record<Part, string> = {
  world: 'yours to download',
  game: `${SHOWN[0]?.title.toLowerCase() ?? 'survival'}, set up for you`,
  power: `running ${hoursOn} h of 24`,
  door: `${ADDED} friends added`,
  backups: 'newest: tonight’s session',
}

/** How far a mark's words reach along the plate, in blocks: the length they are set to, or their own. */
export const reachOf = (mark: Extract<Mark, { kind: 'words' }>) =>
  mark.u + (mark.fit ?? widthOf(mark.text, mark.size))
