// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { AVATAR_STYLES, type AvatarStyle } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { INK } from './avatar-colours'
import { WriterAvatar } from './writer-avatar'
import { markOf } from './writer-mark'

/** Seeds as the API gives them: a hash of an account's id. */
const seed = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32)
const seeds = Array.from({ length: 12 }, (_, i) => seed(`account-${i}`))
const drawn = (style: AvatarStyle, from: string) =>
  decodeURIComponent(renderToStaticMarkup(createElement(WriterAvatar, { avatar: { style, seed: from } })))

describe("a note writer's picture", () => {
  test('is the same drawing for the same style and seed, every time', () => {
    for (const style of AVATAR_STYLES)
      expect(drawn(style, seeds[0] as string)).toBe(drawn(style, seeds[0] as string))
    expect(drawn('mark', 'a-player')).toBe(drawn('mark', 'a-player'))
  })

  test('tells writers apart in every style', () => {
    for (const style of AVATAR_STYLES)
      expect(new Set(seeds.map((s) => drawn(style, s))).size).toBeGreaterThan(9)
  })

  test('is never a black picture: the styles drawn in one colour never use ink', () => {
    for (const style of ['mark', 'identicon', 'minidenticon'] as const)
      for (const s of seeds) expect(drawn(style, s).toLowerCase()).not.toContain(INK)
    for (let i = 0; i < 100; i++) expect(markOf(seed(`account-${i}`)).colour).not.toBe(INK)
  })
})
