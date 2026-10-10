// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { serverCard } from './card.ts'

/**
 * The picture a shared link shows. It is drawn here rather than rendered by anything installed,
 * so what these check is that it is a real PNG of the right size, and that what it says changes
 * with the server it is about.
 */
describe('link picture', () => {
  const card = (patch: Partial<Parameters<typeof serverCard>[0]> = {}) =>
    serverCard({
      name: 'Sunset Valley',
      awake: true,
      online: 4,
      maxPlayers: 10,
      gameVersion: '26.3',
      serverType: null,
      invited: false,
      ...patch,
    })

  test('is a 1200 by 630 PNG, which is what a preview asks for', () => {
    const png = card()
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR: length, kind, then width and height.
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND')
  })

  test('a different server is a different picture', () => {
    expect(card().equals(card({ name: 'Nudge World' }))).toBe(false)
    expect(card().equals(card({ awake: false }))).toBe(false)
    expect(card().equals(card({ online: 5 }))).toBe(false)
    expect(card().equals(card({ invited: true }))).toBe(false)
    // The same server twice is the same bytes, so a CDN can cache it.
    expect(card().equals(card())).toBe(true)
  })

  test('a name too long for two lines is cut, and an empty one still draws', () => {
    expect(card({ name: 'A'.repeat(200) }).length).toBeGreaterThan(1000)
    expect(card({ name: '   ' }).length).toBeGreaterThan(1000)
    // Emoji and anything else the font has no shape for never leave a hole.
    expect(card({ name: '🌅 Sunset 🌅' }).length).toBeGreaterThan(1000)
  })
})
