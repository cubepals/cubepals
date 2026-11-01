// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The beta banner appears on the two account entry pages, using Next's real pathname context. */
import { expect, test } from 'bun:test'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EntryBanner } from './entry-banner'

const router: AppRouterInstance = {
  bfcacheId: '',
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
}

function render(path: string) {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(PathnameContext.Provider, { value: path }, createElement(EntryBanner)),
    ),
  )
}

test('signing in and signing up show the beta letter and dismiss control', () => {
  for (const path of ['/sign-in', '/sign-up']) {
    const html = render(path)
    expect(html).toContain('aria-label="Beta"')
    expect(html).toContain('href="/beta"')
    expect(html).toContain('aria-label="Close"')
  }
})

test('other pages, including nested entry paths, do not show an entry banner', () => {
  for (const path of ['/forgot-password', '/reset-password', '/', '/sign-in/extra', '/sign-up/extra']) {
    expect(render(path)).toBe('')
  }
})
