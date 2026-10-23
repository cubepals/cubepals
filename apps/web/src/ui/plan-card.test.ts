// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The public plan cards' colours, read from the stylesheets themselves (landing/blocks.css and
 * plan-card.module.css): every word, picture and button on each card
 * passes WCAG AA's 4.5:1 on what it sits on. Each colour is resolved from the card's own tokens,
 * and the one product token it takes (tokens.css) is the same in both themes, so a card stays
 * paper and ink in either.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8')
const blocks = read('../landing/blocks.css')
const card = read('plan-card.module.css')
const theme = read('tokens.css')

/** The declarations of the rule written with exactly this selector, as name and value. */
function rule(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`no rule for ${selector}`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/^\s*([\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2]?.trim()]))
}

/** A value with every `var()` replaced from the card's tokens, down to a colour. */
function resolve(value: string, tokens: Record<string, string>): string {
  const used = value.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/)
  if (!used) return value
  const [, name = '', fallback] = used
  const next = tokens[name] ?? fallback
  if (next === undefined) throw new Error(`${name} isn't set on the card`)
  return resolve(next, tokens)
}

/** WCAG 2.2's contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/** The one product token the cards read: muted ink on dark, the same in light and dark. */
const muted = [...theme.matchAll(/--ink-inverse-muted: (#[0-9a-f]{6});/g)].map((m) => m[1] ?? '')
const print = { ...rule(blocks, '.bl-print'), '--ink-inverse-muted': muted[0] ?? '' }
const paper = { ...print, ...rule(card, '.card') }
const ink = { ...paper, ...rule(card, '.paid') }
/** What a card is filled with: the frame's fill, or the panel (blocks.css, `.bl-frame::after`). */
const fill = (tokens: Record<string, string>) => resolve(tokens['--frame-fill'] ?? 'var(--panel)', tokens)
const lit = rule(card, '.paid .lit')

const AA = 4.5

describe('the plan cards’ colours', () => {
  test('Core is white and Plus ink, whatever the theme', () => {
    expect(fill(paper)).toBe('#ffffff')
    expect(fill(ink)).toBe('#0d0d0d')
    expect(new Set(muted).size).toBe(1)
  })

  test('the words, the quieter words and the pictures pass on each card', () => {
    for (const tokens of [paper, ink]) {
      for (const colour of ['var(--fg)', 'var(--plan-card-quiet)', 'var(--plan-card-icon)'])
        expect(contrast(resolve(colour, tokens), fill(tokens))).toBeGreaterThanOrEqual(AA)
    }
  })

  test('Start free is the ink block on Core, and its paper label passes on it', () => {
    expect(resolve('var(--fg)', paper)).toBe('#0d0d0d')
    expect(contrast(resolve('var(--on-fg)', paper), resolve('var(--fg)', paper))).toBeGreaterThanOrEqual(AA)
  })

  test('the lit button is #8c86f2, and its ink label passes on it', () => {
    const block = resolve(lit['--btn-fill'] ?? '', ink)
    expect(block).toBe('#8c86f2')
    expect(contrast(resolve(rule(blocks, '.bl-btn--lit').color ?? '', ink), block)).toBeGreaterThanOrEqual(AA)
  })
})
