// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for what search engines are told, deployment by deployment: robots.txt, the sitemap, and
 * noindex on the pages kept out of search.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { PRIVATE, UNLISTED } from '../lib/site.ts'
import { GUIDES, guideHref } from './(public)/guides.ts'
import robots from './robots.ts'
import sitemap from './sitemap.ts'

const was = { ...process.env }
afterEach(() => {
  for (const name of ['WEB_INDEXABLE', 'WEB_CANONICAL_ORIGIN', 'API_UPSTREAM'] as const) {
    if (was[name] === undefined) delete process.env[name]
    else process.env[name] = was[name]
  }
})
const production = () => {
  process.env.WEB_INDEXABLE = '1'
  process.env.WEB_CANONICAL_ORIGIN = 'https://cubepals.com'
}

describe('robots.txt', () => {
  test('production lets every crawler in but for the API, and names the sitemap', () => {
    production()
    expect(robots()).toEqual({
      rules: { userAgent: '*', allow: '/', disallow: '/api/' },
      sitemap: 'https://cubepals.com/sitemap.xml',
    })
  })

  test('every other deployment turns crawlers away, and so does a forgotten setting', () => {
    for (const value of [undefined, '', '0', 'true']) {
      if (value === undefined) delete process.env.WEB_INDEXABLE
      else process.env.WEB_INDEXABLE = value
      expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } })
    }
  })
})

describe('sitemap.xml', () => {
  const urls = () => sitemap().map((entry) => entry.url)

  test('lists home, pricing and the policies on the canonical origin, and none of the private pages', () => {
    production()
    const listed = urls()
    expect(listed).toContain('https://cubepals.com/')
    expect(listed).toContain('https://cubepals.com/pricing')
    expect(listed).toContain('https://cubepals.com/legal/terms')
    for (const path of ['/browse', '/sign-in', '/join/', '/server/', '/servers', '/design'])
      expect(listed.some((url) => url.includes(path))).toBe(false)
  })

  test('lists approved guides only, and /guides only once one is approved', () => {
    production()
    const listed = urls()
    for (const guide of GUIDES)
      expect(listed.includes(`https://cubepals.com${guideHref(guide)}`)).toBe(guide.approved)
    expect(listed.includes('https://cubepals.com/guides')).toBe(GUIDES.some((guide) => guide.approved))
  })
})

describe('noindex where the plan wants it', () => {
  test('sign-in and the other auth pages', async () => {
    expect((await import('./(auth)/layout.tsx')).metadata.robots).toEqual(UNLISTED)
  })

  test('the directory', async () => {
    expect((await import('./(public)/browse/page.tsx')).metadata.robots).toEqual(UNLISTED)
  })

  test('an invite, even one whose link is broken', async () => {
    const { generateMetadata } = await import('./(public)/join/[code]/page.tsx')
    expect((await generateMetadata({ params: Promise.resolve({ code: '!!' }) })).robots).toEqual(PRIVATE)
  })

  test('a server page, even when the control plane does not answer', async () => {
    process.env.API_UPSTREAM = 'http://127.0.0.1:9'
    const { generateMetadata } = await import('./(public)/server/[slug]/page.tsx')
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'sunset-valley' }) })
    expect(metadata.robots).toEqual(UNLISTED)
    expect(metadata.alternates?.canonical).toBe('/server/sunset-valley')
  })
})
