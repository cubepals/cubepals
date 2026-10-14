// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test } from 'bun:test'
import { BETA_UNREAD, betaOn } from './beta.ts'

const was = process.env.WEB_BETA
afterEach(() => {
  if (was === undefined) delete process.env.WEB_BETA
  else process.env.WEB_BETA = was
})

describe('the beta switch', () => {
  test('is on unless the deployment turns it off', () => {
    delete process.env.WEB_BETA
    expect(betaOn()).toBe(true)
    process.env.WEB_BETA = '1'
    expect(betaOn()).toBe(true)
    process.env.WEB_BETA = '0'
    expect(betaOn()).toBe(false)
  })
})

describe('the check before paint', () => {
  /** Runs the script against a page whose storage holds `stored`, or throws when it is null. */
  const run = (stored: Record<string, string> | null) => {
    const marks = new Set<string>()
    const localStorage = {
      getItem: (key: string) => {
        if (stored === null) throw new Error('storage is blocked')
        return stored[key] ?? null
      },
    }
    const document = { documentElement: { setAttribute: (name: string) => marks.add(name) } }
    new Function('localStorage', 'document', BETA_UNREAD)(localStorage, document)
    return marks
  }

  test('marks a browser that has never closed the banner', () => {
    expect(run({})).toEqual(new Set(['data-beta-unread']))
  })

  test('leaves a browser that closed it or read the letter alone', () => {
    expect(run({ 'cubepals:beta-read': '1' })).toEqual(new Set())
  })

  test('shows nothing where storage is blocked, since a close could not be kept', () => {
    expect(run(null)).toEqual(new Set())
  })
})
