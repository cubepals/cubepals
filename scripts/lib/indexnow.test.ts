// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** IndexNow's ping: the key file, the sitemap it reads, the request it sends, and who sends it. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENVIRONMENT_EXAMPLE, environment } from '../production-values.ts'
import { productionSite } from '../production-website.ts'
import { stagingSite } from '../staging-website.ts'
import { indexNowKey, indexNowRequest, pingsIndexNow, sitemapUrls } from './indexnow.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true })
})
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-test-'))
  dirs.push(dir)
  return dir
}

describe('the key', () => {
  test('is the one public file whose body is its own name', () => {
    expect(indexNowKey()).toMatch(/^[0-9a-f]{32}$/)
  })

  test('is refused when no file, or more than one, is a key', () => {
    const dir = temporary()
    writeFileSync(join(dir, 'abcdef0123456789.txt'), 'something else')
    expect(() => indexNowKey(dir)).toThrow('0 IndexNow key files')
    writeFileSync(join(dir, '0123456789abcdef.txt'), '0123456789abcdef')
    expect(indexNowKey(dir)).toBe('0123456789abcdef')
    writeFileSync(join(dir, 'fedcba9876543210.txt'), 'fedcba9876543210\n')
    expect(() => indexNowKey(dir)).toThrow('2 IndexNow key files')
  })
})

test("the URLs are the built sitemap's", () => {
  const dir = temporary()
  mkdirSync(join(dir, 'server/app'), { recursive: true })
  writeFileSync(
    join(dir, 'server/app/sitemap.xml.body'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      '<url>\n<loc>https://cubepals.com</loc>\n</url>\n' +
      '<url>\n<loc>https://cubepals.com/pricing</loc>\n<lastmod>2026-09-01</lastmod>\n</url>\n</urlset>\n',
  )
  expect(sitemapUrls(dir)).toEqual(['https://cubepals.com', 'https://cubepals.com/pricing'])
})

test('the request is the POST IndexNow documents', () => {
  const { url, init } = indexNowRequest('https://cubepals.com', '0123456789abcdef', [
    'https://cubepals.com',
    'https://cubepals.com/pricing',
  ])
  expect(url).toBe('https://api.indexnow.org/indexnow')
  expect(init.method).toBe('POST')
  expect(init.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' })
  expect(JSON.parse(init.body as string)).toEqual({
    host: 'cubepals.com',
    key: '0123456789abcdef',
    keyLocation: 'https://cubepals.com/0123456789abcdef.txt',
    urlList: ['https://cubepals.com', 'https://cubepals.com/pricing'],
  })
})

describe('who pings', () => {
  const cloudflare = { token: 'stand-in', accountId: 'stand-in' }
  const production = productionSite(
    { CLOUDFLARE_WORKERS_API_TOKEN: cloudflare.token, CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId },
    environment(ENVIRONMENT_EXAMPLE),
  )

  test('production does', () => {
    expect(pingsIndexNow(production)).toBe(true)
  })

  test('staging, whose previews are uploads of it, does not', () => {
    expect(pingsIndexNow(stagingSite(cloudflare))).toBe(false)
  })

  test('nor does production built for another environment, or kept out of search', () => {
    expect(pingsIndexNow({ ...production, env: 'staging' })).toBe(false)
    expect(pingsIndexNow({ ...production, indexable: false })).toBe(false)
  })
})
