// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which pages the edge keeps, for whom, and what the browser is told about each. */
import { describe, expect, test } from 'bun:test'
import { DAY_S, SECOND_MS } from '@blockly/contracts/durations'
import { EDGE, type EdgeCache, FRESH_S, fromEdge } from './edge-cache'
import { markingPartial, PARTIAL } from './partial-render'
import { publicPlans } from './plans'

const ORIGIN = 'https://cubepals.com'
const DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
/** What Next says of every page here, since the frame asks who is signed in. */
const NEXT_PRIVATE = 'private, no-cache, no-store, max-age=0, must-revalidate'
const SIGNED_IN = '__Secure-blockly-prod.session_token=abc.def; ph_phc_x_posthog=%7B%7D'

/** A Worker's cache, a clock, and a Next that says which page it made and how many it has. */
function edge() {
  const kept = new Map<string, Response>()
  const cache: EdgeCache = {
    match: async (key) => kept.get(key.url)?.clone(),
    put: async (key, response) => {
      kept.set(key.url, response)
    },
  }
  let made = 0
  let at = 1_000_000
  const pending: Promise<unknown>[] = []
  const ask = async (path: string, headers: Record<string, string> = {}, version = 'v1') => {
    const response = await fromEdge(
      new Request(`${ORIGIN}${path}`, { headers: { 'user-agent': DESKTOP, ...headers } }),
      {
        version,
        cache,
        render: async (request) => {
          made++
          const form = /Mobi/.test(request.headers.get('user-agent') ?? '') ? 'phone' : 'film'
          return new Response(`<html>${form} ${made}</html>`, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': NEXT_PRIVATE },
          })
        },
        later: (work) => pending.push(work),
        now: () => at,
      },
    )
    await Promise.all(pending.splice(0))
    return { response, body: await response.text() }
  }
  return {
    ask,
    kept,
    made: () => made,
    pass: (ms: number) => {
      at += ms
    },
  }
}

describe('the pages kept at the edge', () => {
  test('a signed-out visitor gets the landing page from the edge after the first', async () => {
    const site = edge()
    const first = await site.ask('/')
    expect(first.response.headers.get(EDGE)).toBe('miss')
    const second = await site.ask('/', { cookie: 'ph_phc_x_posthog=%7B%7D' })
    expect(second.response.headers.get(EDGE)).toBe('hit')
    expect(second.body).toBe(first.body)
    expect(site.made()).toBe(1)
    expect(second.response.headers.get('cache-control')).toBe(
      `public, max-age=0, s-maxage=${FRESH_S}, stale-while-revalidate=${DAY_S}`,
    )
  })

  test('pricing, the guides and the policies are kept too', async () => {
    const site = edge()
    for (const path of ['/pricing', '/guides', '/guides/minecraft-server-cost', '/legal', '/legal/terms']) {
      await site.ask(path)
      expect((await site.ask(path)).response.headers.get(EDGE)).toBe('hit')
    }
  })

  test('someone signed in is never answered from the edge, nor kept there', async () => {
    const site = edge()
    await site.ask('/')
    for (const path of ['/', '/pricing', '/guides', '/legal/terms']) {
      const { response, body } = await site.ask(path, { cookie: SIGNED_IN })
      expect(response.headers.get('cache-control')).toBe(NEXT_PRIVATE)
      expect(response.headers.has(EDGE)).toBe(false)
      expect(body).not.toBe('<html>film 1</html>')
    }
    expect(site.kept.size).toBe(1)
  })

  test("a person's own pages are never kept, signed in or not", async () => {
    const site = edge()
    for (const path of [
      '/servers',
      '/servers/new',
      '/account',
      '/checkout',
      '/admin',
      '/browse',
      '/join/abc',
    ]) {
      for (const headers of [{}, { cookie: SIGNED_IN }] as Record<string, string>[]) {
        const { response } = await site.ask(path, headers)
        expect(response.headers.get('cache-control')).toBe(NEXT_PRIVATE)
        expect(response.headers.has(EDGE)).toBe(false)
      }
    }
    expect(site.kept.size).toBe(0)
  })

  test("Next's own navigation requests go to Next", async () => {
    const site = edge()
    await site.ask('/', { rsc: '1' })
    await site.ask('/?_rsc=x1')
    await site.ask('/pricing', { 'next-router-prefetch': '1' })
    expect(site.kept.size).toBe(0)
  })

  test("a phone's landing page is kept apart from the film's", async () => {
    const site = edge()
    expect((await site.ask('/')).body).toContain('film')
    expect((await site.ask('/', { 'user-agent': IPHONE })).body).toContain('phone')
    expect((await site.ask('/', { 'sec-ch-ua-mobile': '?1', 'user-agent': IPHONE })).body).toContain('phone')
    expect((await site.ask('/')).body).toContain('film')
    expect(site.made()).toBe(2)
  })

  test('a new deploy never answers with the last one’s pages', async () => {
    const site = edge()
    await site.ask('/', {}, 'v1')
    expect((await site.ask('/', {}, 'v2')).response.headers.get(EDGE)).toBe('miss')
    expect(site.made()).toBe(2)
    // Without a version the Worker can't tell deploys apart, so nothing is kept.
    await site.ask('/', {}, '')
    expect(site.made()).toBe(3)
  })

  test('a page past its time is answered while a new one is made', async () => {
    const site = edge()
    await site.ask('/')
    site.pass(FRESH_S * SECOND_MS + 1)
    const stale = await site.ask('/')
    expect(stale.response.headers.get(EDGE)).toBe('stale')
    expect(stale.body).toBe('<html>film 1</html>')
    expect(site.made()).toBe(2)
    expect((await site.ask('/')).body).toBe('<html>film 2</html>')
  })

  test('an answer that sets a cookie is never kept', async () => {
    const kept = new Map<string, Response>()
    const response = await fromEdge(new Request(`${ORIGIN}/`), {
      version: 'v1',
      cache: { match: async () => undefined, put: async (key, value) => void kept.set(key.url, value) },
      render: async () =>
        new Response('<html></html>', {
          headers: { 'content-type': 'text/html', 'set-cookie': 'a=b', 'cache-control': NEXT_PRIVATE },
        }),
      later: () => {},
    })
    expect(response.headers.get('cache-control')).toBe(NEXT_PRIVATE)
    expect(kept.size).toBe(0)
  })
})

describe('a page made without its plans', () => {
  /** A control plane that answers with plans, or none. */
  function controlPlane(plans: unknown[]) {
    const server = Bun.serve({ port: 0, fetch: () => Response.json(plans) })
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  }

  /** The Worker's own render of /pricing: the real plans read, inside the real mark. */
  async function pricing(cache: EdgeCache, pass: () => number, pending: Promise<unknown>[]) {
    const response = await fromEdge(
      new Request(`${ORIGIN}/pricing`, { headers: { 'user-agent': DESKTOP } }),
      {
        version: 'v1',
        cache,
        render: () =>
          markingPartial(async () => {
            const plans = await publicPlans()
            return new Response(`<html>${plans.length} plans</html>`, {
              headers: { 'content-type': 'text/html', 'cache-control': NEXT_PRIVATE },
            })
          }),
        later: (work) => pending.push(work),
        now: pass,
      },
    )
    await Promise.all(pending.splice(0))
    return { response, body: await response.text() }
  }

  test('is answered as Next made it, never kept, and a good copy survives it', async () => {
    const kept = new Map<string, Response>()
    const cache: EdgeCache = {
      match: async (key) => kept.get(key.url)?.clone(),
      put: async (key, response) => void kept.set(key.url, response),
    }
    let at = 1_000_000
    const pending: Promise<unknown>[] = []
    const was = process.env.API_UPSTREAM
    const up = controlPlane([{ key: 'free' }, { key: 'plus' }])
    try {
      // Unreachable: a port nothing listens on.
      process.env.API_UPSTREAM = 'http://127.0.0.1:1'
      for (let i = 0; i < 2; i++) {
        const { response, body } = await pricing(cache, () => at, pending)
        expect(body).toBe('<html>0 plans</html>')
        expect(response.headers.get('cache-control')).toBe(NEXT_PRIVATE)
        expect(response.headers.has(EDGE)).toBe(false)
        expect(response.headers.has(PARTIAL)).toBe(false)
      }
      expect(kept.size).toBe(0)

      // Answering with plans: kept.
      process.env.API_UPSTREAM = up.url
      expect((await pricing(cache, () => at, pending)).response.headers.get(EDGE)).toBe('miss')
      expect(kept.size).toBe(1)
      expect((await pricing(cache, () => at, pending)).response.headers.get(EDGE)).toBe('hit')

      // Past its time and the control plane gone: the good copy is answered, and stays.
      process.env.API_UPSTREAM = 'http://127.0.0.1:1'
      at += FRESH_S * SECOND_MS + 1
      const stale = await pricing(cache, () => at, pending)
      expect(stale.response.headers.get(EDGE)).toBe('stale')
      expect(stale.body).toBe('<html>2 plans</html>')
      expect((await pricing(cache, () => at, pending)).body).toBe('<html>2 plans</html>')
    } finally {
      up.stop()
      if (was === undefined) delete process.env.API_UPSTREAM
      else process.env.API_UPSTREAM = was
    }
  })

  test('an empty table counts as partial too', async () => {
    const empty = controlPlane([])
    const was = process.env.API_UPSTREAM
    process.env.API_UPSTREAM = empty.url
    try {
      const marked = await markingPartial(async () => {
        await publicPlans()
        return new Response('<html></html>')
      })
      expect(marked.headers.has(PARTIAL)).toBe(true)
    } finally {
      empty.stop()
      if (was === undefined) delete process.env.API_UPSTREAM
      else process.env.API_UPSTREAM = was
    }
  })

  test('a render that read its plans is not marked', async () => {
    const full = controlPlane([{ key: 'free' }])
    const was = process.env.API_UPSTREAM
    process.env.API_UPSTREAM = full.url
    try {
      const made = await markingPartial(async () => {
        await publicPlans()
        return new Response('<html></html>')
      })
      expect(made.headers.has(PARTIAL)).toBe(false)
    } finally {
      full.stop()
      if (was === undefined) delete process.env.API_UPSTREAM
      else process.env.API_UPSTREAM = was
    }
  })
})
