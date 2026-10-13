// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the sign-in pages ask the control plane, and what they do when it can't answer in time. */
import { afterEach, describe, expect, test } from 'bun:test'
import { RENDER_READ_MS } from '../../lib/upstream.ts'
import { authMethods, signupsOpen } from './auth-methods.ts'

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

describe('a control plane that is slow to answer', () => {
  test(
    'holds the sign-in page no longer than a render waits',
    async () => {
      // Answers long after a render has stopped waiting, as one that is still waking does.
      const server = Bun.serve({
        port: 0,
        fetch: async () => {
          await Bun.sleep(RENDER_READ_MS * 3)
          return Response.json({ open: true, google: true, github: true, turnstileSiteKey: null })
        },
      })
      const before = process.env.API_UPSTREAM
      process.env.API_UPSTREAM = server.url.origin
      try {
        const started = performance.now()
        const [methods, open] = await Promise.all([authMethods(), signupsOpen()])
        expect(performance.now() - started).toBeLessThan(RENDER_READ_MS * 2)
        expect(methods).toEqual({ google: false, github: false, turnstileSiteKey: null })
        expect(open).toBe('unknown')
      } finally {
        if (before === undefined) delete process.env.API_UPSTREAM
        else process.env.API_UPSTREAM = before
        server.stop(true)
      }
    },
    RENDER_READ_MS * 4,
  )
})
