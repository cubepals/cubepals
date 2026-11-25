// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Account pages keep their form visible and their artwork framed. */
import { expect, test } from 'bun:test'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AuthLayout from './layout'

const router: AppRouterInstance = {
  bfcacheId: '',
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
}

test('account pages retain their form and the shared frame beside the artwork', () => {
  const form = createElement('form', { id: 'account-form' }, 'Account details')
  const html = renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(PathnameContext.Provider, { value: '/sign-in' }, createElement(AuthLayout, null, form)),
    ),
  )
  expect(html).toContain('<form id="account-form">Account details</form>')
  expect(html).toMatch(/class="bk-imageblock[^"]*"/)
  expect(html).toContain('aria-label="Cubepals"')
  expect(html).toContain(encodeURIComponent('/imagery/chunk-asleep.png'))
})
