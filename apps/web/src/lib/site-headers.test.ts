// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The site's own headers, as each of the three places that send them says them: next.config.ts
 * for what Next answers, the Worker for what it answers itself, and public/_headers for the
 * assets' files.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import config from '../../next.config'
import { SITE_HEADERS, withSiteHeaders } from './site-headers'

const expected = Object.fromEntries(SITE_HEADERS.map(({ key, value }) => [key, value]))

describe('SITE_HEADERS', () => {
  test('are the five the site sends', () => {
    expect(expected).toEqual({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000',
    })
  })
})

describe("next.config.ts's headers", () => {
  const indexable = process.env.WEB_INDEXABLE
  afterEach(() => {
    if (indexable === undefined) delete process.env.WEB_INDEXABLE
    else process.env.WEB_INDEXABLE = indexable
  })
  const forEveryPath = async () => {
    const rules = await config.headers()
    const all = rules.filter((rule) => rule.source === '/:path*')
    return Object.fromEntries(all.flatMap((rule) => rule.headers.map(({ key, value }) => [key, value])))
  }

  test('sends them on every path of production, with no noindex', async () => {
    process.env.WEB_INDEXABLE = '1'
    expect(await forEveryPath()).toEqual(expected)
  })

  test('sends them on every path of any other deployment, beside its noindex', async () => {
    delete process.env.WEB_INDEXABLE
    expect(await forEveryPath()).toEqual({ ...expected, 'X-Robots-Tag': 'noindex' })
  })
})

describe('withSiteHeaders', () => {
  test("adds them to an answer that can't be changed, keeping its status, headers and body", async () => {
    using upstream = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }, { status: 409 }) })
    const answer = withSiteHeaders(await fetch(upstream.url))
    for (const [key, value] of Object.entries(expected)) expect(answer.headers.get(key)).toBe(value)
    expect(answer.status).toBe(409)
    expect(answer.headers.get('content-type')).toStartWith('application/json')
    expect(await answer.json()).toEqual({ ok: true })
  })

  test('adds them to a redirect, which keeps its address', () => {
    const answer = withSiteHeaders(Response.redirect('https://cubepals.com/pricing', 308))
    expect(answer.status).toBe(308)
    expect(answer.headers.get('location')).toBe('https://cubepals.com/pricing')
    expect(answer.headers.get('X-Frame-Options')).toBe('DENY')
  })

  test('keeps a value the answer already says', () => {
    const answer = withSiteHeaders(new Response('', { headers: { 'Referrer-Policy': 'no-referrer' } }))
    expect(answer.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(answer.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

describe('public/_headers', () => {
  test("gives every file from the Worker's assets the same headers", () => {
    const lines = readFileSync(join(import.meta.dir, '../../public/_headers'), 'utf8').split('\n')
    const start = lines.indexOf('/*')
    expect(start).toBeGreaterThanOrEqual(0)
    const rule: Record<string, string> = {}
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('  ')) break
      const at = line.indexOf(':')
      rule[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    expect(rule).toEqual(expected)
  })
})
