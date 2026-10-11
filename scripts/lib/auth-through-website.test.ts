// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { authWorks } from './auth-through-website'

const JSON_TYPE = { 'content-type': 'application/json' }

/** A site whose control plane answers as cubepals.com's does, with `callback` for Google's way back. */
const site = (callback: () => Response) =>
  Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/auth/get-session') return new Response('null', { headers: JSON_TYPE })
      if (path === '/api/auth/sign-in/social')
        return new Response('{"url":"https://accounts.google.com/o/oauth2/v2/auth"}', { headers: JSON_TYPE })
      if (path === '/api/auth/callback/google') return callback()
      if (path === '/api/auth/sign-in/email') return new Response('{}', { status: 401, headers: JSON_TYPE })
      if (path === '/api/auth/sign-up/email') return new Response('{}', { status: 400, headers: JSON_TYPE })
      return new Response('not found', { status: 404 })
    },
  })

describe('every way in, through the website', () => {
  test('a control plane answering as it should passes', async () => {
    const web = site(
      () => new Response(null, { status: 302, headers: { location: '/sign-in?error=state_mismatch' } }),
    )
    try {
      expect(await authWorks(`http://127.0.0.1:${web.port}`)).toContain('all answer')
    } finally {
      web.stop(true)
    }
  })

  test('a page in place of Google’s redirect, as the Worker gave on 2026-10-11, fails and names it', async () => {
    const web = site(
      () =>
        new Response('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } }),
    )
    try {
      await expect(authWorks(`http://127.0.0.1:${web.port}`)).rejects.toThrow('Google return')
    } finally {
      web.stop(true)
    }
  })
})
