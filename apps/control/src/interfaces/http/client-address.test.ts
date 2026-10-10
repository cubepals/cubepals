// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { CLIENT_ADDRESS_HEADER } from '../../app/ports/auth.ts'
import { type AddressTrust, FORWARDED_BY, FORWARDED_CLIENT, withClientAddress } from './client-address.ts'

const SECRET = 'a-proxy-secret-long-enough'
const ON_FLY = { proxySecret: SECRET, hostHeader: 'fly-client-ip' }
const at = (headers: Record<string, string>, trust: AddressTrust = ON_FLY) =>
  withClientAddress(new Request('https://control.test/api/auth/sign-in/email', { headers }), trust).headers

describe('the client address sign-in counts by', () => {
  test('is the web tier’s word when it carries the secret', () => {
    const headers = at({
      [FORWARDED_CLIENT]: '203.0.113.7',
      [FORWARDED_BY]: SECRET,
      'fly-client-ip': '198.51.100.1',
    })
    expect(headers.get(CLIENT_ADDRESS_HEADER)).toBe('203.0.113.7')
    // The secret goes no further than this.
    expect(headers.get(FORWARDED_BY)).toBeNull()
    expect(headers.get(FORWARDED_CLIENT)).toBeNull()
  })

  test('is the host’s own when the secret is wrong or missing, so nobody names their own', () => {
    const guesses: Record<string, string>[] = [{ [FORWARDED_BY]: 'a-guess-of-the-same-length!' }, {}]
    for (const given of guesses) {
      const headers = at({ [FORWARDED_CLIENT]: '203.0.113.7', ...given, 'fly-client-ip': '198.51.100.1' })
      expect(headers.get(CLIENT_ADDRESS_HEADER)).toBe('198.51.100.1')
    }
  })

  test('is never what the caller wrote in the header Better Auth reads', () => {
    expect(
      at({ [CLIENT_ADDRESS_HEADER]: '192.0.2.99', 'fly-client-ip': '198.51.100.1' }).get(
        CLIENT_ADDRESS_HEADER,
      ),
    ).toBe('198.51.100.1')
    const local = { proxySecret: null, hostHeader: null }
    expect(
      at({ [CLIENT_ADDRESS_HEADER]: '192.0.2.99', 'fly-client-ip': '198.51.100.1' }, local).has(
        CLIENT_ADDRESS_HEADER,
      ),
    ).toBe(false)
  })

  test('takes IPv6, and nothing that isn’t an address', () => {
    expect(at({ [FORWARDED_CLIENT]: '2001:db8::1', [FORWARDED_BY]: SECRET }).get(CLIENT_ADDRESS_HEADER)).toBe(
      '2001:db8::1',
    )
    const junk = at({
      [FORWARDED_CLIENT]: 'nobody, 10.0.0.1',
      [FORWARDED_BY]: SECRET,
      'fly-client-ip': '198.51.100.1',
    })
    expect(junk.get(CLIENT_ADDRESS_HEADER)).toBe('198.51.100.1')
  })

  test('a request keeps its method, body and cookie', async () => {
    const request = new Request('https://control.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { cookie: 'a=b', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.test' }),
    })
    const passed = withClientAddress(request, ON_FLY)
    expect(passed.method).toBe('POST')
    expect(passed.headers.get('cookie')).toBe('a=b')
    expect(await passed.json()).toEqual({ email: 'x@example.test' })
  })
})
