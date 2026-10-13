// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The previews' router: which hosts it knows, and what it changes on the way and back. */
import { describe, expect, test } from 'bun:test'
import router, { aliasOf, fromAlias, toAlias } from './preview-router.ts'

const ENV = {
  PREVIEW_DOMAIN: 'preview.cubepals.com',
  PREVIEW_SUFFIX: '-blockly-web-staging.team.workers.dev',
}
const ALIAS = 'https://pr-26-blockly-web-staging.team.workers.dev'
const BRANDED = 'https://pr-26.preview.cubepals.com'

describe("the previews' router", () => {
  test("knows a pull request's address, and no other", () => {
    expect(aliasOf('pr-26.preview.cubepals.com', ENV)).toBe(ALIAS)
    expect(aliasOf('preview.cubepals.com', ENV)).toBeNull()
    expect(aliasOf('pr-0.preview.cubepals.com', ENV)).toBeNull()
    expect(aliasOf('pr-26.preview.cubepals.com.example', ENV)).toBeNull()
    expect(aliasOf('pr-26.x.preview.cubepals.com', ENV)).toBeNull()
    expect(aliasOf('x.pr-26.preview.cubepals.com', ENV)).toBeNull()
  })

  test('sends the request on as it is, saying the address it was sent to', async () => {
    const sent = toAlias(
      new Request(`${BRANDED}/api/auth/sign-in/email?x=1`, {
        method: 'POST',
        headers: { host: 'pr-26.preview.cubepals.com', cookie: 'a=b' },
        body: '{}',
      }),
      ALIAS,
    )
    expect(sent.url).toBe(`${ALIAS}/api/auth/sign-in/email?x=1`)
    expect(sent.redirect).toBe('manual')
    expect(sent.headers.get('x-forwarded-host')).toBe('pr-26.preview.cubepals.com')
    expect(sent.headers.get('x-forwarded-proto')).toBe('https')
    expect(sent.headers.get('cookie')).toBe('a=b')
    expect(await sent.text()).toBe('{}')
  })

  test('answers on the branded address, cookies as they were, and out of search', () => {
    const answer = fromAlias(
      new Response(null, {
        status: 302,
        headers: { location: `${ALIAS}/servers?a=1`, 'set-cookie': 'session=s; Path=/; HttpOnly' },
      }),
      ALIAS,
      BRANDED,
    )
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe(`${BRANDED}/servers?a=1`)
    expect(answer.headers.get('set-cookie')).toBe('session=s; Path=/; HttpOnly')
    expect(answer.headers.get('x-robots-tag')).toBe('noindex')
    const elsewhere = fromAlias(
      new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o' } }),
      ALIAS,
      BRANDED,
    )
    expect(elsewhere.headers.get('location')).toBe('https://accounts.google.com/o')
  })

  test('turns away any other host without sending it anywhere', async () => {
    const answer = await router.fetch(new Request('https://preview.cubepals.com/'), ENV)
    expect(answer.status).toBe(404)
  })
})
