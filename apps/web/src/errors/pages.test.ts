// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { OPERATOR } from '../legal/operator'
import { logo, STATIC_PAGES, staticPage } from './pages'

const here = (path: string) => new URL(path, import.meta.url)
const read = (path: string) => readFileSync(here(path))
const inline = {
  figure: `data:image/png;base64,${read('../../public/errors/moss-shrugging.png').toString('base64')}`,
  lockup: read('../../../../brand/lockup-horizontal.svg').toString('utf8').trim(),
  icon: `data:image/svg+xml,${encodeURIComponent(read('../../../../brand/favicon.svg').toString('utf8').trim())}`,
}

describe('the standalone error pages', () => {
  for (const [file, { token }] of Object.entries(STATIC_PAGES)) {
    test(`${file} is as pages.ts writes it, with the support address`, () => {
      const written = readFileSync(here(`../../public/errors/${file}`), 'utf8')
      expect(written).toBe(staticPage(file as keyof typeof STATIC_PAGES, inline))
      expect(written).toContain(`mailto:${OPERATOR.emails.support}`)
      expect(written).toContain('aria-label="Cubepals"')
      expect(written).toContain('<link rel="icon" href="data:image/svg+xml,')
      expect(written).toContain(inline.figure)
      // Nothing it loads is a request: the pages stand in for a site that may be down.
      expect(written).not.toMatch(/<(?:img|script|link)[^>]+(?:src|href)="https?:/)
      if (token) expect(written).toContain(token)
    })
  }
  test('Cloudflare’s pages carry the token its docs require for each class', () => {
    expect(STATIC_PAGES['cloudflare-5xx.html'].token).toBe('::CLOUDFLARE_ERROR_500S_BOX::')
    expect(STATIC_PAGES['cloudflare-1xxx.html'].token).toBe('::CLOUDFLARE_ERROR_1000S_BOX::')
  })
})

describe('logo', () => {
  test('puts the class and the title in the svg tag, not at the first > of the file', () => {
    const drawn = '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1" aria-label="Cubepals"><path d="M0 0"/></svg>'
    expect(logo(drawn)).toBe(
      '<?xml version="1.0"?>\n<svg class="logo" viewBox="0 0 1 1" aria-label="Cubepals"><title>Cubepals</title><path d="M0 0"/></svg>',
    )
  })
})
