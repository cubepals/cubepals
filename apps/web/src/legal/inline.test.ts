// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { piecesOf, plainOf, sectionCalled } from './inline.ts'

describe('a policy sentence', () => {
  test('reads its links, emphasis and tokens, and leaves the rest as text', () => {
    expect(piecesOf('See [the Terms](/legal/terms#plans), **really**, or write to {support}.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'the Terms', href: '/legal/terms#plans' },
      { kind: 'text', text: ', ' },
      { kind: 'strong', text: 'really' },
      { kind: 'text', text: ', or write to ' },
      { kind: 'token', token: 'support' },
      { kind: 'text', text: '.' },
    ])
  })

  test('a {word} that is not a token stays as written', () => {
    expect(piecesOf('Braces {like this} and {nope} stay.')).toEqual([
      { kind: 'text', text: 'Braces {like this} and {nope} stay.' },
    ])
  })

  test('as plain text, tokens are said and links keep their words', () => {
    expect(plainOf('{brand} by {name}: [Terms](/legal/terms)', (t) => `<${t}>`)).toBe(
      '<brand> by <name>: Terms',
    )
  })

  test('what stands out is read too: a token or a section inside ** ** is filled in', () => {
    const say = (t: string) => `<${t}>`
    expect(plainOf('**{brand} is not official.** Ask {support}.', say)).toBe(
      '<brand> is not official. Ask <support>.',
    )
    expect(plainOf('**See {§b}.**', say, ['a', 'b'])).toBe('See section 2.')
  })

  test('a {§id} is a reference to a section, said by its place in its policy', () => {
    expect(piecesOf('As {§chip-in} says.')).toEqual([
      { kind: 'text', text: 'As ' },
      { kind: 'section', id: 'chip-in' },
      { kind: 'text', text: ' says.' },
    ])
    expect(plainOf('See {§b}.', (t) => t, ['a', 'b'])).toBe('See section 2.')
    expect(sectionCalled(['a', 'b', 'c'], 'a')).toBe('section 1')
    expect(() => sectionCalled(['a', 'b'], 'c')).toThrow()
  })
})
