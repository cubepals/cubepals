// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Offensive names found in their usual disguises, and the places and words that only look like them let through. */
import { describe, expect, test } from 'bun:test'
import { offensive } from '@blockly/contracts/names'

describe('offensive names', () => {
  test('slurs, hate and sexual words are found', () => {
    for (const name of ['Fuck this', 'cunt', 'Nigger Town', 'faggot', 'retard', 'Nazi Base', 'Hitler Youth'])
      expect(offensive(name)).toBe(true)
  })

  test('so are their usual disguises', () => {
    for (const name of [
      'sh1t',
      'n1gg3r',
      'b!tch',
      'fück',
      'fuuuuuck',
      'fvck',
      'f u c k',
      'f-u-c-k',
      'f.u.c.k',
      'n i g g e r',
    ])
      expect(offensive(name)).toBe(true)
  })

  test('the address a name becomes is found too', () => {
    expect(offensive('shit-show')).toBe(true)
    expect(offensive('motherfucker-smp')).toBe(true)
  })

  test('common words, places and surnames with one inside are not', () => {
    for (const name of [
      'Sunset Valley',
      'Scunthorpe',
      'Penistone',
      'Essex',
      'Middlesex',
      'Sussex SMP',
      'Cockermouth',
      'Clitheroe',
      'Dickinson',
      'Hancock',
      'Peacock Farm',
      'Assassins',
      'Classic',
      'class-hit',
      'Cocktail Bar',
      'Grape Escape',
      'Therapist',
      'Arsenal',
      'Cumberland',
      'Analysis',
      'Shuttlecock',
      'Ashkenazi Kitchen',
      'Titanic',
      'Tit for tat',
      'A B C Builders',
    ])
      expect(offensive(name)).toBe(false)
  })
})
