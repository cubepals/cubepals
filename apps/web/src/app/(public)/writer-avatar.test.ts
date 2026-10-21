// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { AVATAR_STYLES, type AvatarStyle } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { INK } from './avatar-colours'
import { identiconSvg, WriterAvatar } from './writer-avatar'
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

  test('tells writers apart in every style', async () => {
    for (const style of AVATAR_STYLES.filter((style) => style !== 'identicon'))
      expect(new Set(seeds.map((s) => drawn(style, s))).size).toBeGreaterThan(9)
  })

  test('is never a black picture: the styles drawn in one colour never use ink', () => {
    for (const style of ['mark', 'minidenticon'] as const)
      for (const s of seeds) expect(drawn(style, s).toLowerCase()).not.toContain(INK)
    for (let i = 0; i < 100; i++) expect(markOf(seed(`account-${i}`)).colour).not.toBe(INK)
  })

  test('an identicon shows its sand until DiceBear has loaded, then a drawing that is always the same', async () => {
    const first = seeds[0] as string
    expect(drawn('identicon', first)).toContain('rect width="1" height="1" fill="#e6e3dc"')
    expect(await identiconSvg(first, '#3a2e8f')).toBe(await identiconSvg(first, '#3a2e8f'))
    const svgs = await Promise.all(seeds.map((s) => identiconSvg(s, '#3a2e8f')))
    expect(new Set(svgs).size).toBeGreaterThan(9)
    for (const svg of svgs) expect(svg.toLowerCase()).not.toContain(INK)
  })
})
