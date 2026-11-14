// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The drawn server's states, as the scene steps them and the card says them: it starts, then
 * comes online; once everyone has walked off it says it is stopping and saving its world for as
 * long as the light takes to go out, and only then sleeps.
 */
import { describe, expect, test } from 'bun:test'
import { cardOf } from './Card'
import { nextPower } from './scene'

describe('the drawn server', () => {
  test('a join starts it, and it comes up after its start, whatever it was doing', () => {
    expect(nextPower('join', { power: 'sleeping', held: 0, about: false })).toBe('starting')
    expect(nextPower('join', { power: 'stopping', held: 1, about: false })).toBe('starting')
    expect(nextPower('join', { power: 'starting', held: 1, about: false })).toBe('starting')
    expect(nextPower('join', { power: 'starting', held: 2, about: false })).toBe('online')
  })

  test('a leave empties it, it stops once nobody is on the grass, and it sleeps once its world is saved', () => {
    expect(nextPower('leave', { power: 'online', held: 5, about: true })).toBe('emptying')
    expect(nextPower('leave', { power: 'emptying', held: 9, about: true })).toBe('emptying')
    expect(nextPower('leave', { power: 'emptying', held: 9, about: false })).toBe('stopping')
    expect(nextPower('leave', { power: 'stopping', held: 1, about: false })).toBe('stopping')
    expect(nextPower('leave', { power: 'stopping', held: 1.5, about: false })).toBe('sleeping')
  })

  test('its card says each state as the product does, a stopping server’s included', () => {
    expect(cardOf('emptying', 2)).toEqual({ status: 'online', detail: '2 / 5 players' })
    expect(cardOf('emptying', 0)).toEqual({
      status: 'online',
      detail: '0 / 5 players · Sleeps soon if nobody joins',
    })
    expect(cardOf('stopping', 0)).toEqual({
      status: 'stopped',
      label: 'Stopping',
      detail: 'Saving your world',
    })
    expect(cardOf('sleeping', 0)).toEqual({ status: 'sleeping', detail: 'Wakes up when someone joins' })
    expect(cardOf('starting', 0)).toEqual({ status: 'starting', detail: 'Waking your world' })
  })
})
