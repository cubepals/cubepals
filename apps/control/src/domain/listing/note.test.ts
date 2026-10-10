// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { cleanNote, NOTE_MAX_LENGTH, sameNote } from './note.ts'

/** Characters by their code points: written as themselves, the invisible ones would hide here too. */
const cp = (...points: number[]) => String.fromCodePoint(...points)
const RLO = cp(0x202e)
const PDF = cp(0x202c)
const ZWSP = cp(0x200b)
const LRI = cp(0x2066)
const PDI = cp(0x2069)
const BOM = cp(0xfeff)
const LRM = cp(0x200e)
const ZWJ = cp(0x200d)

describe('a note on a server', () => {
  test('is one line of plain words, trimmed, with single spaces', () => {
    expect(cleanNote('  Great   builds,\n\tfriendly\r\nfolks!  ')).toEqual({
      note: 'Great builds, friendly folks!',
    })
    // Composed as one character, however it was typed.
    expect(cleanNote(`Cafe${cp(0x301)}`)).toEqual({ note: `Caf${cp(0xe9)}` })
  })

  test('hides nothing: direction overrides, zero-width and control characters go', () => {
    expect(cleanNote(`abc${RLO}dcba${PDF}`)).toEqual({ note: 'abcdcba' })
    expect(cleanNote(`fr${ZWSP}ee${LRI} dia${PDI}monds${cp(0)}${cp(0x7f)}`)).toEqual({
      note: 'free diamonds',
    })
    expect(cleanNote(`${BOM}hello${LRM}`)).toEqual({ note: 'hello' })
  })

  test('what went leaves no double space, so a note said again is still the same note', () => {
    const spaced = cleanNote(`nice ${ZWSP} server ${cp(1)} here`)
    expect(spaced).toEqual({ note: 'nice server here' })
    expect(sameNote('nice server here', 'Nice server here')).toBe(true)
  })

  test('hides nothing in format characters: tags and annotation marks go too', () => {
    // Tag characters spell hidden text a moderator reading the note wouldn't see.
    expect(cleanNote(`hi${cp(0xe0041, 0xe0042, 0xe0043)}${cp(0xfff9, 0xfffa, 0xfffb)}`)).toEqual({
      note: 'hi',
    })
    expect(cleanNote(cp(0xe0041, 0xe0042))).toEqual({ refused: 'Write something first.' })
  })

  test('a tower of marks on one letter is cut to what languages use', () => {
    const tower = `a${cp(0x30d).repeat(127)}`
    expect(cleanNote(tower)).toEqual({ note: `a${cp(0x30d).repeat(4)}` })
    // Vietnamese stacks two on a letter, which stay.
    expect(cleanNote(`Vi${cp(0x1ec7)}t`)).toEqual({ note: `Vi${cp(0x1ec7)}t` })
    expect(cleanNote(`e${cp(0x302, 0x323)}`)).toEqual({ note: cp(0x1ec7) })
  })

  test('keeps emoji whole, joiners and variation selectors included', () => {
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    const heart = cp(0x2764, 0xfe0f)
    expect(cleanNote(`${family} ${heart}`)).toEqual({ note: `${family} ${heart}` })
    expect(family.includes(ZWJ)).toBe(true)
  })

  test('says why when nothing is left, or when it is too long', () => {
    expect(cleanNote(`   ${ZWSP}\n `)).toEqual({ refused: 'Write something first.' })
    expect(cleanNote('x'.repeat(NOTE_MAX_LENGTH))).toEqual({ note: 'x'.repeat(NOTE_MAX_LENGTH) })
    expect(cleanNote('x'.repeat(NOTE_MAX_LENGTH + 1))).toEqual({ refused: 'A note is up to 128 characters.' })
    // Counted after cleaning, as it will be shown.
    expect(cleanNote(`${'x'.repeat(NOTE_MAX_LENGTH)}${ZWSP}${ZWSP}   `)).toEqual({
      note: 'x'.repeat(NOTE_MAX_LENGTH),
    })
  })

  test('the same words again are the same note, whatever their case', () => {
    expect(sameNote('Great server', 'great SERVER')).toBe(true)
    expect(sameNote('Great server', 'Great server!')).toBe(false)
  })
})
