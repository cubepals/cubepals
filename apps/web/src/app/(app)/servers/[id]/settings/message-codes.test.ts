// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The style bar's codes: around a selection, at the caret, coming off again, and never split or
 * left behind.
 */
import { describe, expect, test } from 'bun:test'
import { motdRuns, motdText } from '@blockly/contracts'
import { pressedCodes, withCode } from './message-codes'

/** The message with `code` applied to the first place `words` appear. */
const around = (motd: string, words: string, code: string) => {
  const start = motd.indexOf(words)
  return withCode(motd, start, start + words.length, code)
}

describe('the style bar', () => {
  test('puts a colour around the selection and gives the rest back its look', () => {
    const next = around('Hello world', 'Hello', '6')
    expect(next.motd).toBe('&6Hello&r world')
    // The same words stay selected, their code with them.
    expect(next.motd.slice(next.start, next.end)).toBe('&6Hello')
    expect(motdText(next.motd)).toBe('Hello world')
  })

  test('restores a colour that ran through the selection', () => {
    expect(around('&bHello big world', 'big', 'l').motd).toBe('&bHello &lbig&b world')
  })

  test('keeps the styles a colour would otherwise clear', () => {
    expect(around('&lHello world', 'world', 'c').motd).toBe('&lHello &c&lworld')
  })

  test('adds nothing after the selection when the message ends there or starts over', () => {
    expect(around('Hello world', 'world', 'l').motd).toBe('Hello &lworld')
    expect(around('Hello &aworld', 'Hello ', 'l').motd).toBe('&lHello &aworld')
  })

  test('takes a style off when the whole selection has it', () => {
    const bold = around('Hello world', 'world', 'l')
    const plain = withCode(bold.motd, bold.start, bold.end, 'l')
    expect(plain.motd).toBe('Hello world')
    expect(around('&6&lGold coins', 'coins', 'l').motd).toBe('&6&lGold &6coins')
  })

  test('adds a style to all of a selection that has it only in places', () => {
    expect(withCode('&lbig&r small', 2, 13, 'l').motd).toBe('&lbig small')
  })

  test('clears a selection back to the list’s grey with reset', () => {
    expect(around('&d&lcubepals duels', 'duels', 'r').motd).toBe('&d&lcubepals &rduels')
  })

  test('takes in codes inside the selection rather than leaving them behind', () => {
    expect(around('&4red&9blue', 'red&9blue', 'e').motd).toBe('&eredblue')
    // Codes just before the selection too: they only ever coloured it.
    const gold = around('&d&lcubepals &f&lduels &8· PvP', 'duels', '6')
    expect(gold.motd).toBe('&d&lcubepals &6&lduels&f&l &8· PvP')
    expect(gold.motd.slice(gold.start, gold.end)).toBe('&6&lduels')
  })

  test('with nothing selected, applies from the caret on', () => {
    const at = 'Hello '.length
    const gold = withCode('Hello world', at, at, '6')
    expect(gold).toEqual({ motd: 'Hello &6world', start: 8, end: 8 })
    const bold = withCode(gold.motd, gold.start, gold.end, 'l')
    expect(bold).toEqual({ motd: 'Hello &6&lworld', start: 10, end: 10 })
    // Pressed again at the same place, bold comes off, and reset takes the colour too.
    const unbold = withCode(bold.motd, bold.start, bold.end, 'l')
    expect(unbold).toEqual({ motd: 'Hello &6world', start: 8, end: 8 })
    expect(withCode(unbold.motd, unbold.start, unbold.end, 'r').motd).toBe('Hello world')
    // Further on, past some words, bold comes off by starting the colour over.
    expect(withCode('&6&lGold coins', 9, 9, 'l').motd).toBe('&6&lGold &6coins')
  })

  test('never splits a code', () => {
    // A caret between & and 6 goes after the code; a selection edge there takes the code in.
    expect(withCode('&6Gold', 1, 1, 'l').motd).toBe('&6&lGold')
    expect(withCode('&6Gold', 1, 6, 'c').motd).toBe('&cGold')
  })

  test('draws what it writes as the preview would', () => {
    expect(motdRuns(around('cubepals duels', 'cubepals', 'd').motd)).toEqual([
      { text: 'cubepals', colour: '#FF55FF', styles: [] },
      { text: ' duels', colour: '#808080', styles: [] },
    ])
  })

  test('shows as pressed what all of the selection has, or the caret’s look', () => {
    expect(pressedCodes('&6&lGold &6coins', 0, 16)).toEqual(['6'])
    expect(pressedCodes('&6&lGold &6coins', 4, 8)).toEqual(['6', 'l'])
    expect(pressedCodes('&6&lGold &6coins', 16, 16)).toEqual(['6'])
    expect(pressedCodes('Hello', 2, 2)).toEqual([])
  })
})
