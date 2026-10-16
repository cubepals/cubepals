// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for links that leave Cubepals: which hrefs count as another site, what such a link
 * renders, and that no `<a>` in the web app reaches another site without going through `OutLink`.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isExternal, NEW_TAB, OutLink } from './out-link'

describe('isExternal', () => {
  test('another site over http or https is external', () => {
    for (const href of [
      'https://modrinth.com/app',
      'http://minecraft.wiki/w/Ender_Dragon',
      'HTTPS://github.com/x',
    ])
      expect(isExternal(href)).toBe(true)
  })

  test('a host that only ends in our name is another site', () => {
    expect(isExternal('https://notcubepals.com/')).toBe(true)
    expect(isExternal('https://cubepals.com.example.org/')).toBe(true)
  })

  test('Cubepals and its subdomains are ours', () => {
    for (const href of [
      'https://cubepals.com/pricing',
      'https://staging.cubepals.com/',
      'https://a.play.cubepals.com',
    ])
      expect(isExternal(href)).toBe(false)
  })

  test('paths, anchors, email, phone and app links are not', () => {
    for (const href of [
      '/legal/terms',
      '#price',
      'mailto:support@cubepals.com',
      'tel:+1555',
      'modrinth://mod/x',
    ])
      expect(isExternal(href)).toBe(false)
  })
})

describe('OutLink', () => {
  const render = (props: Record<string, string>, text = 'Modrinth') =>
    renderToStaticMarkup(createElement(OutLink, props as { href: string }, text))

  test('a link to another site opens in a new tab and says so', () => {
    const html = render({ href: 'https://modrinth.com/app' })
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain(`<span class="bk-visually-hidden"> (${NEW_TAB})</span>`)
  })

  test('a link that names itself says so in its name', () => {
    const html = render({ href: 'https://modrinth.com/mod/create', 'aria-label': 'Create on Modrinth' })
    expect(html).toContain(`aria-label="Create on Modrinth (${NEW_TAB})"`)
    expect(html).not.toContain('bk-visually-hidden')
  })

  test('any other link stays in this tab', () => {
    for (const href of ['https://cubepals.com/guides', 'mailto:support@cubepals.com', 'modrinth://mod/x']) {
      const html = render({ href })
      expect(html).not.toContain('target=')
      expect(html).not.toContain(NEW_TAB)
    }
  })
})

/** Every `.tsx` under `apps/web/src`, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : []
  })
}

/** An opening tag, arrow functions in its props included. */
const TAG = /<(a|Link)\b((?:=>|[^>])*)>/g
/** An href written out as one of ours: a path, an anchor, an email or a phone number. */
const OURS = /^(\/|#|mailto:|tel:)/

/**
 * Whether a tag's href may stay as it is. Next's Link takes any expression, since its pages are
 * ours, but not another site written out; a bare `<a>` takes only an href written out as one of ours.
 */
function stays(tag: string, attributes: string): boolean {
  const href = /\bhref=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\}|(\{))/.exec(attributes)
  if (href === null) return true
  const written = href[1] ?? href[2] ?? href[3]
  if (tag === 'Link') return written === undefined || !/^https?:/i.test(written)
  return written !== undefined && OURS.test(written)
}

describe('the web app', () => {
  const root = join(import.meta.dir, '..')

  test('reaches another site only through OutLink', () => {
    const bare = sources(root)
      .filter((file) => file !== join(import.meta.dir, 'out-link.tsx'))
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(TAG)]
          .filter(([, tag = '', attributes = '']) => !stays(tag, attributes))
          .map(([whole]) => `${relative(root, file)}: ${whole.replace(/\s+/g, ' ')}`),
      )
    expect(bare).toEqual([])
  })
})
