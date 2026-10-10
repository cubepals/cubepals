// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the Worker does before Next: www sent on, and sign-in calls told the browser's real address. */
import { afterEach, describe, expect, test } from 'bun:test'
import { beforeNext } from './before-next'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})
const configured = () => {
  process.env = {
    ...saved,
    WEB_CANONICAL_ORIGIN: 'https://cubepals.com',
    WEB_CLIENT_ADDRESS_HEADER: 'cf-connecting-ip',
    WEB_PROXY_SECRET: 'a-proxy-secret-long-enough',
  }
}
const forged = {
  'cf-connecting-ip': '198.51.100.1',
  'x-blockly-client': '203.0.113.9',
  'x-blockly-proxy': 'a-guess',
  'x-blockly-client-address': '203.0.113.9',
}

describe('a request before Next sees it', () => {
  test('www is sent to the site itself for good, with its path and query', () => {
    configured()
    const answer = beforeNext(new Request('https://www.cubepals.com/guides/one?ref=x'))
    expect(answer).toBeInstanceOf(Response)
    expect((answer as Response).status).toBe(308)
    expect((answer as Response).headers.get('location')).toBe('https://cubepals.com/guides/one?ref=x')
  })

  test('the site, and any other host such as workers.dev, go on to Next', () => {
    configured()
    for (const url of ['https://cubepals.com/pricing', 'https://blockly-web.example.workers.dev/']) {
      const request = new Request(url)
      expect(beforeNext(request)).toBe(request)
    }
  })

  test('a sign-in call carries the address the edge saw, never the one the browser claimed', () => {
    configured()
    for (const path of ['/api/auth', '/api/auth/sign-in/email']) {
      const passed = beforeNext(new Request(`https://cubepals.com${path}`, { headers: forged })) as Request
      expect(passed.headers.get('x-blockly-client')).toBe('198.51.100.1')
      expect(passed.headers.get('x-blockly-proxy')).toBe('a-proxy-secret-long-enough')
      expect(passed.headers.get('x-blockly-client-address')).toBeNull()
    }
  })

  test('other paths pass untouched, a differently cased one included', () => {
    configured()
    for (const path of ['/api/trpc/servers.list', '/API/auth/get-session', '/api/authority']) {
      const request = new Request(`https://cubepals.com${path}`, { headers: forged })
      expect(beforeNext(request)).toBe(request)
    }
  })
})
