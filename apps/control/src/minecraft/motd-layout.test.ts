// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server list's lines, against the widths and breaks of the game's own font and splitter, so
 * what the settings page draws and what the control plane refuses is what players see.
 */
import { describe, expect, test } from 'bun:test'
import { MOTD_LINE_WIDTH, motdCutSentence, motdLayout } from '@blockly/contracts/motd-layout'

const text = (line: Array<{ char: string }>) => line.map((glyph) => glyph.char).join('')
const shown = (motd: string) => motdLayout(motd).lines.map(text)
/** How far one character moves the line along, in bold or not. */
const glyphAdvance = (char: string, bold: boolean) =>
  motdLayout(`${bold ? '&l' : ''}${char}W`).lines[0]?.[1]?.x

describe('the server list’s lines', () => {
  test('measure each character as the game’s font does', () => {
    expect(MOTD_LINE_WIDTH).toBe(267)
    expect(glyphAdvance('W', false)).toBe(6)
    expect(glyphAdvance('W', true)).toBe(7)
    expect(['i', '!', '.', ',', ':', ';', '|'].map((char) => glyphAdvance(char, false))).toEqual([
      2, 2, 2, 2, 2, 2, 2,
    ])
    expect(glyphAdvance('l', false)).toBe(3)
    expect(glyphAdvance('t', false)).toBe(4)
    expect(glyphAdvance('f', false)).toBe(5)
    expect(glyphAdvance('@', false)).toBe(7)
    expect(glyphAdvance(' ', false)).toBe(4)
    expect(glyphAdvance(' ', true)).toBe(5)
    expect(glyphAdvance('é', false)).toBe(6)
    expect(glyphAdvance('漢', false)).toBe(9)
  })

  test('fill a line up to 267 pixels and carry the rest onto the next', () => {
    // 44 of a 6 pixel glyph is 264; the 45th would make 270.
    expect(shown('W'.repeat(45))).toEqual(['W'.repeat(44), 'W'])
    // Narrow glyphs fit more: 133 of a 2 pixel one is 266.
    expect(shown('i'.repeat(134))).toEqual(['i'.repeat(133), 'i'])
    // Bold moves each a pixel more: 38 of 7 is 266.
    expect(shown(`&l${'W'.repeat(39)}`)).toEqual(['W'.repeat(38), 'W'])
  })

  test('break at the last space, dropping it, and inside a word only when there is none', () => {
    const words = `${'W'.repeat(40)} ${'W'.repeat(10)}`
    expect(shown(words)).toEqual(['W'.repeat(40), 'W'.repeat(10)])
    expect(motdLayout(words).lines[1]?.[0]?.x).toBe(0)
  })

  test('take no room for codes, and drop a section sign code the game doesn’t know', () => {
    expect(shown('&6Gold &lbold')).toEqual(['Gold bold'])
    expect(shown('§zHi')).toEqual(['Hi'])
    expect(shown('Tom & Jerry &z')).toEqual(['Tom & Jerry &z'])
    const [gold, bold] = [motdLayout('&6&lGo').lines[0]?.[0], motdLayout('&6&lGo').lines[0]?.[1]]
    expect(gold).toMatchObject({ char: 'G', colour: '#FFAA00', styles: ['bold'], x: 0, advance: 7 })
    expect(bold?.x).toBe(7)
  })

  test('show two lines and leave the rest off, counted', () => {
    const fits = 'W'.repeat(88)
    expect(motdLayout(fits).cutCount).toBe(0)
    const over = motdLayout(`${'W'.repeat(88)}ABCDEF`)
    expect(over.lines.map(text)).toEqual(['W'.repeat(44), 'W'.repeat(44)])
    expect(over.cut.map(text)).toEqual(['ABCDEF'])
    expect(over.cutCount).toBe(6)
    expect(motdCutSentence(6)).toBe('The last 6 characters won’t show in the server list.')
    expect(motdCutSentence(1)).toBe('The last character won’t show in the server list.')
  })
})
