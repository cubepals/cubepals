// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The previews' router: which hosts it knows, and what it changes on the way and back. */
import { describe, expect, test } from 'bun:test'
import router, { aliasOf, commitOf, fromAlias, toAlias, upstreamOf } from './preview-router.ts'

const recorded = new Map([
  ['b226b58', '0123abcd'],
  ['badbadb', 'https://elsewhere.example'],
])
const ENV = {
  PREVIEW_DOMAIN: 'preview.cubepals.com',
  PREVIEW_SUFFIX: '-blockly-web-staging.team.workers.dev',
  COMMITS: { get: async (key: string) => recorded.get(key) ?? null },
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

  test("knows a commit's address by its first seven characters, and no other", () => {
    expect(commitOf('b226b58.preview.cubepals.com', ENV)).toBe('b226b58')
    expect(commitOf('0000000.preview.cubepals.com', ENV)).toBe('0000000')
    expect(commitOf('b226b5.preview.cubepals.com', ENV)).toBeNull()
    expect(commitOf('b226b58a.preview.cubepals.com', ENV)).toBeNull()
    expect(commitOf('B226B58.preview.cubepals.com', ENV)).toBeNull()
    expect(commitOf('g226b58.preview.cubepals.com', ENV)).toBeNull()
    expect(commitOf('b226b58.preview.cubepals.com.example', ENV)).toBeNull()
    expect(commitOf('x.b226b58.preview.cubepals.com', ENV)).toBeNull()
    expect(commitOf('pr-26.preview.cubepals.com', ENV)).toBeNull()
  })

  test('sends a commit to its own version, and a pull request to its alias', async () => {
    expect(await upstreamOf('b226b58.preview.cubepals.com', ENV)).toBe(
      'https://0123abcd-blockly-web-staging.team.workers.dev',
    )
    expect(await upstreamOf('pr-26.preview.cubepals.com', ENV)).toBe(ALIAS)
    expect(await upstreamOf('c0ffee0.preview.cubepals.com', ENV)).toBeNull()
    // Only a version's prefix is followed, whatever the record says.
    expect(await upstreamOf('badbadb.preview.cubepals.com', ENV)).toBeNull()
    const { COMMITS: _, ...unbound } = ENV
    expect(await upstreamOf('b226b58.preview.cubepals.com', unbound)).toBeNull()
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
    const unknown = await router.fetch(new Request('https://c0ffee0.preview.cubepals.com/'), ENV)
    expect(unknown.status).toBe(404)
  })
})
