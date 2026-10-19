// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The Worker's 503: what it answers when Next throws or answers a 5xx without a page. */
import { describe, expect, spyOn, test } from 'bun:test'
import { unavailable, withFallback } from './fallback'

const page = new Request('https://cubepals.com/pricing', { headers: { accept: 'text/html' } })
const assets = {
  fetch: async (request: Request) =>
    new URL(request.url).pathname === '/errors/unavailable.html'
      ? new Response('<h1>fallback</h1>', { headers: { 'content-type': 'text/html' } })
      : new Response('no', { status: 404 }),
}

describe('withFallback', () => {
  test('passes an answer through', async () => {
    const ok = await withFallback(page, assets, async () => new Response('hello'))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('hello')
  })

  test('answers 503 with the static page when the handler throws', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    const down = await withFallback(page, assets, async () => {
      throw new Error('Unexpected loadManifest(/.next/server/preview-props.json)')
    })
    quiet.mockRestore()
    expect(down.status).toBe(503)
    expect(await down.text()).toBe('<h1>fallback</h1>')
    expect(down.headers.get('cache-control')).toBe('no-store')
  })

  test('answers 503 for a 5xx that is not a page, and lets a 5xx page through', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    const bare = await withFallback(
      page,
      assets,
      async () => new Response('Internal Server Error', { status: 500 }),
    )
    quiet.mockRestore()
    expect(bare.status).toBe(503)
    const ours = await withFallback(
      page,
      assets,
      async () => new Response('<h1>ours</h1>', { status: 500, headers: { 'content-type': 'text/html' } }),
    )
    expect(ours.status).toBe(500)
  })

  test('leaves the control plane’s own 5xx alone, but catches a throw', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    const json = await withFallback(page, assets, async () => new Response('{}', { status: 500 }), false)
    expect(json.status).toBe(500)
    const threw = await withFallback(
      page,
      assets,
      async () => Promise.reject(new TypeError('fetch failed')),
      false,
    )
    quiet.mockRestore()
    expect(threw.status).toBe(503)
  })
})

describe('unavailable', () => {
  test('follows the assets’ redirect to the page', async () => {
    const moved = {
      fetch: async (request: Request) =>
        request.url.endsWith('.html')
          ? new Response(null, { status: 307, headers: { location: '/errors/unavailable' } })
          : new Response('<h1>moved</h1>'),
    }
    expect(await (await unavailable(page, moved)).text()).toBe('<h1>moved</h1>')
  })

  test('still answers 503 with a few lines when the assets fail or are missing', async () => {
    const broken = { fetch: async () => Promise.reject(new Error('no assets')) }
    for (const failing of [broken, undefined]) {
      const response = await unavailable(page, failing)
      expect(response.status).toBe(503)
      expect(await response.text()).toContain('support@cubepals.com')
    }
  })

  test('gives a call that did not ask for a page a bare 503', async () => {
    const call = new Request('https://cubepals.com/api/x', { headers: { accept: 'application/json' } })
    const response = await unavailable(call, assets)
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('Service unavailable')
  })
})
