// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test } from 'bun:test'
import { signupsOpen } from './auth-methods.ts'

const realFetch = globalThis.fetch
const answer = (respond: () => Promise<Response>) => {
  globalThis.fetch = (async () => respond()) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('whether sign-up has room', () => {
  test('is what the control plane says', async () => {
    answer(async () => Response.json({ open: true }))
    expect(await signupsOpen()).toBe('open')
    answer(async () => Response.json({ open: false }))
    expect(await signupsOpen()).toBe('full')
  })

  test('is unknown when the control plane cannot be reached or cannot answer', async () => {
    answer(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await signupsOpen()).toBe('unknown')
    answer(async () => new Response('upstream down', { status: 502 }))
    expect(await signupsOpen()).toBe('unknown')
    answer(async () => Response.json({ something: 'else' }))
    expect(await signupsOpen()).toBe('unknown')
  })
})
