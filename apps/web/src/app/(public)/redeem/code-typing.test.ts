// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The gift code field as it is typed in, pasted into and deleted from, and the redeem form as the
 * page first draws it.
 */
import { describe, expect, test } from 'bun:test'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../../lib/api'
import { ViewerProvider } from '../../../lib/viewer'
import { arrived, type CodeText, deletion, pasted, remaining, typed } from './code-typing'
import { RedeemGift } from './redeem-gift'

/** The field with a `|` where its caret is. */
const shown = ({ value, caret }: CodeText): string => `${value.slice(0, caret)}|${value.slice(caret)}`

/** The field from text with a `|` for its caret. */
const field = (text: string): CodeText => ({ value: text.replaceAll('|', ''), caret: text.indexOf('|') })

/** The field after typing `keys` at its caret. */
function type(text: string, keys: string): string {
  let now = field(text)
  for (const key of keys) {
    const raw = now.value.slice(0, now.caret) + key + now.value.slice(now.caret)
    now = typed(now, raw, now.caret + 1)
  }
  return shown(now)
}

/** The field after Backspace (or Delete, `forward`) at its caret, as the browser does it. */
function erase(text: string, way: 'backward' | 'forward' = 'backward'): string {
  const now = field(text)
  const at = way === 'backward' ? now.caret - 1 : now.caret
  const raw = now.value.slice(0, at) + now.value.slice(at + 1)
  return shown(
    typed(now, raw, at, deletion(way === 'backward' ? 'deleteContentBackward' : 'deleteContentForward')),
  )
}

describe('typing a gift code', () => {
  test('it comes out in capitals, O, I and L as digits, with a dash after every four', () => {
    expect(type('|', '7kq2abcde')).toBe('7KQ2-ABCD-E|')
    expect(type('|', 'oil')).toBe('011|')
  })

  test('what can never be in a code doesn’t go in', () => {
    expect(type('|', 'u!? ')).toBe('|')
    expect(type('7KQ2|', '-')).toBe('7KQ2|')
  })

  test('the fourth character doesn’t bring a dash before there is a fifth', () => {
    expect(type('|', '7KQ2')).toBe('7KQ2|')
    expect(type('7KQ2|', 'A')).toBe('7KQ2-A|')
  })

  test('typing in the middle keeps the caret after what was typed, before any dash', () => {
    expect(type('7KQ|2-ABCD', 'X')).toBe('7KQX|-2ABC-D')
    expect(type('7KQ2|-ABCD', 'X')).toBe('7KQ2-X|ABC-D')
  })

  test('never more than sixteen characters', () => {
    expect(type('7KQ2-ABCD-EFGH-JKMN|', 'P')).toBe('7KQ2-ABCD-EFGH-JKMN|')
    expect(type('7KQ2-AB|CD-EFGH-JKMN', 'P')).toBe('7KQ2-AB|CD-EFGH-JKMN')
  })

  test('deleting across a dash takes the character beyond it', () => {
    expect(erase('7KQ2-|ABCD')).toBe('7KQ|A-BCD')
    expect(erase('7KQ2|-ABCD', 'forward')).toBe('7KQ2|-BCD')
    expect(erase('7KQ2-A|BCD')).toBe('7KQ2|-BCD')
    expect(erase('7KQ2-A|')).toBe('7KQ2|')
  })

  test('the line under the field says how much is left', () => {
    expect(remaining('')).toBe('16 characters, from your gift email.')
    expect(remaining('7KQ2-ABCD')).toBe('8 more characters.')
    expect(remaining('7KQ2-ABCD-EFGH-JKM')).toBe('1 more character.')
    expect(remaining('7KQ2-ABCD-EFGH-JKMN')).toBe('That’s the whole code.')
  })
})

describe('pasting a gift code', () => {
  test('a line from the email keeps just the code, over whatever was there', () => {
    const line = 'Here’s your gift. Your code is 7KQ2-ABCD-EFGH-JKMN, and it’s yours to keep.'
    expect(shown(pasted(field('XY|'), 2, 2, line))).toBe('7KQ2-ABCD-EFGH-JKMN|')
  })

  test('part of a code goes in where the caret is', () => {
    expect(shown(pasted(field('7K|'), 2, 2, 'q2 ab'))).toBe('7KQ2-AB|')
    expect(shown(pasted(field('7KQ2-|EFGH'), 5, 5, 'abcd'))).toBe('7KQ2-ABCD|-EFGH')
  })

  test('over a selection, and never past sixteen characters', () => {
    expect(shown(pasted(field('7KQ2-ABCD'), 5, 9, 'ef'))).toBe('7KQ2-EF|')
    expect(shown(pasted(field('7KQ2-ABCD-EFGH-|'), 15, 15, 'JKMNPQ'))).toBe('7KQ2-ABCD-EFGH-JKMN|')
  })

  test('a code in the link is written the same way', () => {
    expect(arrived('7kq2abcdefghjkmn')).toBe('7KQ2-ABCD-EFGH-JKMN')
    expect(arrived('7KQ2 ABCD')).toBe('7KQ2-ABCD')
  })
})

/** The redeem form as the page first draws it, signed in or not, with `?code=` from the link. */
const form = (signedIn: boolean, code?: string): string =>
  renderToStaticMarkup(
    createElement(
      SearchParamsContext.Provider,
      { value: new URLSearchParams(code === undefined ? '' : { code }) },
      createElement(
        ApiProvider,
        null,
        // biome-ignore lint/correctness/noChildrenProp: with no JSX in a test, its props are where the provider's children are typed
        createElement(ViewerProvider, { signedIn, children: createElement(RedeemGift) }),
      ),
    ),
  )

describe('the redeem form', () => {
  test('the field is labelled, shows the shape, and leaves the code as typed', () => {
    const html = form(true)
    const input = html.match(/<input[^>]*>/)?.[0] ?? ''
    const id = input.match(/ id="([^"]+)"/)?.[1]
    expect(html).toContain(`<label class="bk-field__label" for="${id}">Gift code`)
    expect(input).toContain('placeholder="XXXX-XXXX-XXXX-XXXX"')
    expect(input).toContain('autoCapitalize="characters"')
    expect(input).toContain('autoComplete="off"')
    expect(input).toContain('autoCorrect="off"')
    expect(input).toContain('spellCheck="false"')
  })

  test('the line saying what’s left is announced, and tied to the field', () => {
    const html = form(true)
    const note = html.match(/<p id="([^"]+)" class="bk-field__help" aria-live="polite">([^<]*)</)
    expect(note?.[2]).toBe('16 characters, from your gift email.')
    expect(html).toContain(`aria-describedby="${note?.[1]}"`)
  })

  test('Redeem waits for a whole code', () => {
    expect(form(true)).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/)
    expect(form(true, '7KQ2-ABCD')).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/)
    const whole = form(true, '7kq2 abcd efgh jkmn')
    expect(whole).toContain('value="7KQ2-ABCD-EFGH-JKMN"')
    expect(whole).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/)
    expect(whole).toContain('That’s the whole code.')
  })
})
