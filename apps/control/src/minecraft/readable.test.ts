// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * That every arrival's and pad's words read where they stand: from where a player first sees them,
 * at a size, a tilt and a breadth the rules allow, all on the screen, and clear of every other
 * label and sign there (`readable.ts`; the numbers' sources are in `docs/minecraft/readable-text.md`).
 */
import { describe, expect, test } from 'bun:test'
import CLEARANCE from './arcade/clearance.json' with { type: 'json' }
import type { Label } from './arcade/datapack.ts'
import { HUB_MARKERS } from './arcade/hub.ts'
import { markerRoom } from './arcade/label-space.ts'
import { signExtent } from './arcade/signs.ts'
import { ARCADE_LABELS, ARCADE_READS, ARCADE_SIGNS } from './arcade.ts'
import {
  crowd,
  LEAST_LETTER,
  letterPixels,
  MOST_TILT,
  underTitle,
  unreadable,
  viewFrom,
  WIDEST,
} from './readable.ts'
import { type Rect, type Screen, seen, seenBox, type View } from './sight.ts'

const SCREEN: Screen = { width: 1920, height: 1080, fov: 70 }

const words = (label: Label) =>
  label.text
    .map((run) => run.text)
    .join(' ')
    .replace(/\s+/g, ' ')

/** Everything else shown in the Arcade, as it falls on the screen from a view: labels, signs and markers. */
function others(self: Label, view: View): Array<[string, Rect]> {
  const onScreen = (rect: Rect | null): rect is Rect =>
    rect !== null && rect.right > 0 && rect.left < SCREEN.width && rect.bottom > 0 && rect.top < SCREEN.height
  const labels = ARCADE_LABELS.filter((label) => label !== self).map((label): [string, Rect | null] => [
    `"${words(label)}"`,
    seen(label, view, SCREEN),
  ])
  const signs = ARCADE_SIGNS.map((sign): [string, Rect | null] => {
    const [from, to] = signExtent(sign)
    return [`the sign at ${sign.at.join(' ')}`, seenBox(from, to, view, SCREEN)]
  })
  const markers = HUB_MARKERS.map((marker): [string, Rect | null] => {
    const room = markerRoom(marker)
    const half = room.width / 2
    const [x, y, z] = room.at
    return [
      `the marker at ${marker.at.join(' ')}`,
      seenBox([x - half, y, z - half], [x + half, y + room.height, z + half], view, SCREEN),
    ]
  })
  return [...labels, ...signs, ...markers].filter((entry): entry is [string, Rect] => onScreen(entry[1]))
}

describe('every arrival’s and pad’s words read where they stand', () => {
  test('there are words at each pad and each arrival that has any', () => {
    expect(ARCADE_READS.map(({ label }) => words(label))).toEqual([
      'Parkour Stand here to play',
      'The pit Stand here to play',
      'Falling floor Stand here to play',
      'Parkour Step off to start the clock',
      'Wait here for the next round',
    ])
  })

  test('each is large enough, level enough, narrow enough, and all on every screen, from where it is first read', () => {
    for (const { label, from } of ARCADE_READS)
      expect([words(label), unreadable(label, from)]).toEqual([words(label), []])
  })

  test('an arrival’s words stand clear over the title it shows, on the reading screen', () => {
    for (const read of ARCADE_READS)
      expect([words(read.label), underTitle(read)]).toEqual([words(read.label), []])
    expect(ARCADE_READS.filter((read) => read.titled).length).toBe(2)
  })

  test('nothing in the world hides any of it from there, as measured in the world', () => {
    for (const { label } of ARCADE_READS) {
      const measured = CLEARANCE.sight.find((seen) => seen.at.join(' ') === label.at.join(' '))
      expect([words(label), measured?.hidden]).toEqual([words(label), 0])
    }
  })

  test('each is clear of every other label, sign and marker on the screen there', () => {
    for (const { label, from } of ARCADE_READS) {
      const own = seen(label, from, SCREEN)
      if (own === null) throw new Error(`${words(label)} isn't seen`)
      const crowding = others(label, from)
        .filter(([, rect]) => crowd(own, rect))
        .map(([what]) => what)
      expect([words(label), crowding]).toEqual([words(label), []])
    }
  })

  test('the rules find what breaks them: words in a player’s face, too small, too high, too wide', () => {
    const view = viewFrom('0.5 64 0.5 180 0')
    const at = (z: number, y: number, scale = 1, text = 'Stand here to play'): Label => ({
      at: [0.5, y, z],
      tag: 'test',
      text: [{ text, color: 'white' }],
      scale,
      facing: 'south',
    })
    expect(unreadable(at(-6, 65.5), view)).toEqual([])
    expect(unreadable(at(-0.5, 65.5, 3), view).some((rule) => rule.includes('wide'))).toBe(true)
    expect(unreadable(at(-20, 65.5), view).some((rule) => rule.includes(`under ${LEAST_LETTER}`))).toBe(true)
    expect(unreadable(at(-6, 68), view).some((rule) => rule.includes('level look'))).toBe(true)
    expect(letterPixels(at(-6, 65.5), view)).toBeGreaterThan(LEAST_LETTER)
    expect([MOST_TILT, WIDEST]).toEqual([15, 41])
  })
})
