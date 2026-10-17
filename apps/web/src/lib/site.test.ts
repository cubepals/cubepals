// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pageMetadata } from './site.ts'

/**
 * What a link pasted anywhere shows is Cubepals: the title, the site's name, the description and
 * the picture's alt text. Blockly is the codename, and stays in the code.
 */
describe('what a link preview says', () => {
  test("a page's own preview names Cubepals", () => {
    const said = JSON.stringify(
      pageMetadata({ title: 'Pricing', description: 'What it costs.', path: '/pricing' }),
    )
    expect(said).toContain('Pricing · Cubepals')
    expect(said).not.toMatch(/blockly/i)
  })

  // The previews that need a request to render are read as written: every word they can put in
  // front of a person, with the comments and imports (which keep the codename) taken out.
  test.each([
    '../app/layout.tsx',
    './site.ts',
    '../app/(public)/server/[slug]/page.tsx',
    '../app/(public)/join/[code]/page.tsx',
  ])('%s never says the codename', (path) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '')
      .replace(/^import .*$|\bfrom '[^']*'/gm, '')
    expect(source).toContain('export')
    expect(source).not.toMatch(/blockly/i)
  })
})
