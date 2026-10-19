// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writes the standalone error pages (src/errors/pages.ts) to public/errors/. Run it after changing
 * the words in src/errors/copy.ts or the figure:
 *
 *     bun apps/web/scripts/error-pages.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { STATIC_PAGES, staticPage } from '../src/errors/pages.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url))
const inline = {
  figure: `data:image/png;base64,${read('../public/errors/moss-shrugging.png').toString('base64')}`,
  lockup: read('../../../brand/lockup-horizontal.svg').toString('utf8').trim(),
  icon: `data:image/svg+xml,${encodeURIComponent(read('../../../brand/favicon.svg').toString('utf8').trim())}`,
}
for (const file of Object.keys(STATIC_PAGES) as Array<keyof typeof STATIC_PAGES>)
  writeFileSync(new URL(`../public/errors/${file}`, import.meta.url), staticPage(file, inline))
