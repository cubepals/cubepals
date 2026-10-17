// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's floating words and markers: that each is a text or item display the game hides
 * behind what stands in front of it, readable on its background, that each has its room clear of
 * the world's blocks, and that each flat on a wall sits on the wall's solid face, as
 * `scripts/arcade-clearance.ts` measured them in `ARCADE_WORLD`.
 */
import { describe, expect, test } from 'bun:test'
import { ARCADE_FILES, ARCADE_LABELS } from '../arcade.ts'
import { WAITING_FILES } from '../duels-waiting.ts'
import clearance from './clearance.json' with { type: 'json' }
import { INK, type Label, PAPER } from './datapack.ts'
import { HUB_MARKERS } from './hub.ts'
import { inRoom, lineWidths, markerRoom, PLATE_PAD, type Room, roomOf, wallOf } from './label-space.ts'
import { ARCADE_WORLD } from './maps.ts'

const everyCommand = [...ARCADE_FILES, ...WAITING_FILES].flatMap((file) => file.content.split('\n'))

const rooms: Array<[string, Room]> = [
  ...ARCADE_LABELS.map((label): [string, Room] => [
    `the label "${label.text.map((run) => run.text).join('')}"`,
    roomOf(label),
  ]),
  ...HUB_MARKERS.map((marker): [string, Room] => [`the ${marker.marker} marker`, markerRoom(marker)]),
]

const label = (text: string, more: Partial<Label> = {}): Label => ({
  at: [0.5, 0, 0.5],
  tag: 'test',
  text: [{ text, color: PAPER }],
  ...more,
})

describe('the floating words on the Arcade and Duels', () => {
  test('every one is a text display the game hides behind blocks, its words on a plate of Ink; none is a name over an entity', () => {
    const plates = everyCommand.filter((command) => command.includes('"arcade.plate"'))
    const words = everyCommand.filter(
      (command) => command.startsWith('summon minecraft:text_display') && !command.includes('text:" "'),
    )
    expect(words).toHaveLength(ARCADE_LABELS.length)
    expect(plates).toHaveLength(ARCADE_LABELS.length)
    for (const text of words) {
      expect(text).toContain('see_through:false')
      // No shadow: on the plate it would fall a pixel past the words, onto its edge.
      expect(text).toContain('shadow:false')
      expect(text).toContain('background:0,')
    }
    for (const plate of plates) {
      expect(plate).toContain('see_through:false')
      // Ink, opaque, as one signed ARGB number.
      expect(plate).toContain(`background:${0xff000000 | Number.parseInt(INK.slice(1), 16)}`)
    }
    // A name shown over an armor stand or any other entity is drawn through every wall.
    for (const command of everyCommand) {
      expect(command).not.toContain('armor_stand')
      expect(command).not.toContain('CustomNameVisible')
    }
  })

  test('every label’s words sit in the middle of their own plate, the same room round them on every side', () => {
    const plates = everyCommand.filter((command) => command.includes('"arcade.plate"'))
    ARCADE_LABELS.forEach((shown, i) => {
      const plate = plates[i] ?? ''
      const numbers = (name: string) =>
        (plate.match(new RegExp(`${name}:\\[([^\\]]+)\\]`))?.[1] ?? '')
          .split(',')
          .map((n) => Number.parseFloat(n))
      const [sx = 0, sy = 0] = numbers('scale')
      const [tx = 0, ty = 0] = numbers('translation')
      // A space's background, scaled and moved as the plate is (`label.ts`): its box, in blocks.
      const [width, height] = [sx / 8, sy / 4]
      const box = {
        left: tx + width / 10 - width / 2,
        right: tx + width / 10 + width / 2,
        bottom: ty,
        top: ty + height,
      }
      // The words' ink, as the game draws it: a pixel over where the label stands to its lines'
      // height less one, and across, their width less the gap after the last letter, from a pixel
      // right of centre (measured in a 26.2 client: on a plate centred without it, the words stood
      // three pixels from its left edge and one from its right).
      const lines = lineWidths(shown.widest ?? shown.text)
      const px = (shown.scale ?? 1) / 40
      const widest = Math.max(...lines)
      const ink = {
        left: (1 - widest / 2) * px,
        right: (widest / 2) * px,
        bottom: px,
        top: (lines.length * 10 - 1) * px,
      }
      const pads = [ink.left - box.left, box.right - ink.right, ink.bottom - box.bottom, box.top - ink.top]
      for (const pad of pads) expect(pad).toBeCloseTo(PLATE_PAD * px, 4)
    })
  })

  test('each display stands where it is written: no x or z is a whole number, which the game would move half a block', () => {
    const summons = everyCommand.filter((command) =>
      /^(execute .* run )?summon minecraft:(text|item)_display -?\d/.test(command),
    )
    expect(summons.length).toBeGreaterThan(0)
    for (const command of summons) {
      const [x, , z] = command
        .replace(/^.* summon /, 'summon ')
        .split(' ')
        .slice(2, 5)
      expect(x, command).toContain('.')
      expect(z, command).toContain('.')
    }
  })

  test('a label turns to its reader only in the open; one by a wall, or a board before its dome, is flat on it', () => {
    const flat = ARCADE_LABELS.filter((shown) => shown.facing !== undefined)
    // The boards, the two credit lines under the floor's and the pit's signs, the stairs, both
    // passages, the three machines, and the parkour's and the floor's words, facing their arrivals.
    expect(flat).toHaveLength(4 + 2 + 1 + 2 + 3 + 2)
    expect(
      flat.filter((shown) => shown.tag.startsWith('arcade.board.')).map((shown) => shown.facing),
    ).toEqual(['north', 'north', 'north', 'north'])
  })

  test('its words wrap at its line width, and its room is as wide as its widest line', () => {
    expect(lineWidths([{ text: 'Back', color: PAPER }])).toEqual([6 + 6 + 6 + 5])
    expect(lineWidths([{ text: 'Back', color: PAPER, bold: true }])).toEqual([7 + 7 + 7 + 6])
    expect(lineWidths([{ text: 'a\nbb', color: PAPER }])).toEqual([6, 12])
    expect(lineWidths([{ text: `${'W'.repeat(30)} ${'W'.repeat(30)}`, color: PAPER }])).toEqual([184, 180])
    // The plate's room: its words and two pixels round them, as wide each side as its wider half.
    expect(roomOf(label('WWWW')).width).toBeCloseTo((2 * (12 + 2)) / 40)
    expect(roomOf(label('WWWW', { scale: 2 })).height).toBeCloseTo((2 * (10 - 2 + 4)) / 40)
  })

  test('a turning label sweeps round its middle; a flat one only the plane it stands in', () => {
    const wide = label('W'.repeat(30))
    // Half of (180 + 2) / 40 is 2.275 blocks: two blocks east of its middle is in its sweep.
    expect(inRoom(roomOf(wide), [2, 0, 0])).toBe(true)
    expect(inRoom(roomOf(wide), [0, 0, 2])).toBe(true)
    expect(inRoom(roomOf(wide), [3, 0, 0])).toBe(false)
    expect(inRoom(roomOf(wide), [0, 1, 0])).toBe(false)
    const flat = roomOf({ ...wide, facing: 'south' })
    expect(inRoom(flat, [2, 0, 0])).toBe(true)
    expect(inRoom(flat, [0, 0, 1])).toBe(false)
    expect(inRoom(flat, [0, 0, -1])).toBe(false)
  })
})

describe('the floating words against the world’s blocks', () => {
  test("every label and marker has its room clear of the world's blocks, as measured in ARCADE_WORLD", () => {
    // A new world is measured again: `bun scripts/arcade-clearance.ts`.
    expect(clearance.world).toBe(ARCADE_WORLD.sha512)
    for (const [name, room] of rooms) {
      const measured = clearance.rooms.find(
        (candidate) =>
          candidate.at.every((value, i) => value === room.at[i]) &&
          (candidate as { facing?: string }).facing === room.flat?.facing,
      )
      // A label or marker that moved is measured where it now is.
      expect(measured, `${name}, at ${room.at.join(' ')}, was never measured`).toBeDefined()
      expect(room.height, `${name} is taller than the room measured for it`).toBeLessThanOrEqual(
        measured?.height ?? 0,
      )
      expect(room.width / 2, `${name} reaches into the blocks beside it`).toBeLessThanOrEqual(
        measured?.reach ?? 0,
      )
    }
  })

  test('every label and marker flat on a wall stands a twentieth of a block off it, all of it on the wall’s solid face', () => {
    const onWalls = rooms.filter(([, room]) => wallOf(room) !== null)
    // The stairs, both passages' words and doors, the three machines, two games' credit lines and
    // the four boards on their domes.
    expect(onWalls.length).toBe(1 + 2 * 2 + 3 + 2 + 4)
    for (const [name, room] of onWalls) {
      const on = wallOf(room)
      const measured = clearance.rooms.find((candidate) =>
        candidate.at.every((value, i) => value === room.at[i]),
      )
      const face = (measured as { face?: { from: number; top: number; rows: string[] } } | undefined)?.face
      expect(face, `${name}, at ${room.at.join(' ')}, has no wall measured`).toBeDefined()
      if (on === null || face === undefined) continue
      expect(on.gap, `${name} is not a twentieth of a block off its wall`).toBeCloseTo(0.05, 3)
      // Every block whose face it covers, along the wall and up it.
      const [left, right] = [on.mid - room.width / 2, on.mid + room.width / 2]
      const [bottom, top] = [room.at[1], room.at[1] + room.height]
      for (let y = Math.floor(bottom); y < top; y++)
        for (let along = Math.floor(left); along < right; along++) {
          const cell = face.rows[face.top - y]?.[along - face.from]
          expect(cell, `${name} is off its wall's solid face at ${along}, ${y}`).toBe('#')
        }
    }
  })
})
