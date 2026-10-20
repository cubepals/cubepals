// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** When a provider's round trip that lost its place starts again quietly, and when the note shows. */
import { describe, expect, test } from 'bun:test'
import { SIGNUPS_FULL } from '@blockly/contracts'
import { restartWith } from './restart.ts'

const BOTH = ['google', 'github']

describe('a round trip that came back with a state that no longer matches', () => {
  test('starts again with the provider the error page was marked with', () => {
    expect(restartWith('state_mismatch', 'google', null, BOTH)).toBe('google')
    expect(restartWith('state_mismatch', 'github', { provider: 'google', again: false }, BOTH)).toBe('github')
  })

  test('starts again with the provider this tab went to, when the page is unmarked', () => {
    // A callback whose state was already used lands on plain /sign-in.
    expect(restartWith('state_mismatch', null, { provider: 'github', again: false }, BOTH)).toBe('github')
  })

  test('shows the note when nobody can say which provider it was', () => {
    expect(restartWith('state_mismatch', null, null, BOTH)).toBeNull()
  })

  test('starts again only once in a row', () => {
    expect(restartWith('state_mismatch', 'google', { provider: 'google', again: true }, BOTH)).toBeNull()
  })

  test('never for a provider the page no longer offers', () => {
    expect(restartWith('state_mismatch', 'github', null, ['google'])).toBeNull()
  })

  test('never after a refusal: those say what happened instead', () => {
    for (const refused of ['access_denied', 'account_not_linked', SIGNUPS_FULL, 'unable_to_create_user'])
      expect(restartWith(refused, 'google', null, BOTH)).toBeNull()
    expect(restartWith(null, 'google', null, BOTH)).toBeNull()
  })

  test('covers every way Better Auth says the place was lost', () => {
    for (const lost of ['state_not_found', 'please_restart_the_process', 'invalid_code', 'no_code'])
      expect(restartWith(lost, 'google', null, BOTH)).toBe('google')
  })
})
