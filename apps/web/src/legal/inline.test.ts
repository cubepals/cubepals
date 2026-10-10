// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { piecesOf, plainOf } from './inline.ts'

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
})
