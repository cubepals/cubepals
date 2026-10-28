// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the Worker does before Next: www sent on, and calls counted by address told the browser's real one. */
import { afterEach, describe, expect, test } from 'bun:test'
import { beforeNext, toControlPlane } from './before-next'

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

  test('a call counted by address carries the one the edge saw, never the one the browser claimed', () => {
    configured()
    for (const path of [
      '/api/auth',
      '/api/auth/sign-in/email',
      '/api/trpc/sharing.invite',
      '/api/public/invites/x',
    ]) {
      const passed = beforeNext(new Request(`https://cubepals.com${path}`, { headers: forged })) as Request
      expect(passed.headers.get('x-blockly-client')).toBe('198.51.100.1')
      expect(passed.headers.get('x-blockly-proxy')).toBe('a-proxy-secret-long-enough')
      expect(passed.headers.get('x-blockly-client-address')).toBeNull()
    }
  })

  test('other paths pass untouched, a differently cased one included', () => {
    configured()
    for (const path of ['/api/health', '/API/auth/get-session', '/api/authority', '/api/trpcx']) {
      const request = new Request(`https://cubepals.com${path}`, { headers: forged })
      expect(beforeNext(request)).toBe(request)
    }
  })
})

describe('a call to /api goes to the control plane as it is', () => {
  const upstream = () => {
    process.env = { ...saved, API_UPSTREAM: 'https://bly-prod-control.fly.dev' }
  }

  test('to the control plane, path and query kept, told the site’s host and scheme', () => {
    upstream()
    const sent = toControlPlane(
      new Request('https://cubepals.com/api/auth/callback/google?state=s&code=c', {
        headers: { host: 'cubepals.com' },
      }),
    )
    expect(sent?.url).toBe('https://bly-prod-control.fly.dev/api/auth/callback/google?state=s&code=c')
    expect(sent?.redirect).toBe('manual')
    expect(sent?.headers.get('x-forwarded-host')).toBe('cubepals.com')
    expect(sent?.headers.get('x-forwarded-proto')).toBe('https')
  })

  test('a preview says its branded address only when the request came from there', () => {
    const alias = 'https://pr-7-blockly-web-staging.team.workers.dev/api/auth/sign-in/social'
    const via = (host: string) =>
      toControlPlane(new Request(alias, { headers: { 'x-forwarded-host': host } }))?.headers.get(
        'x-forwarded-host',
      )
    process.env = { ...saved, API_UPSTREAM: 'https://bly-staging-control.fly.dev' }
    expect(via('pr-7.preview.cubepals.com')).toBe('pr-7-blockly-web-staging.team.workers.dev')
    process.env.WEB_FORWARDED_HOST = 'pr-7.preview.cubepals.com,b226b58.preview.cubepals.com'
    expect(via('pr-7.preview.cubepals.com')).toBe('pr-7.preview.cubepals.com')
    expect(via('b226b58.preview.cubepals.com')).toBe('b226b58.preview.cubepals.com')
    expect(via('elsewhere.example')).toBe('pr-7-blockly-web-staging.team.workers.dev')
    expect(via('pr-7.preview.cubepals.com,b226b58.preview.cubepals.com')).toBe(
      'pr-7-blockly-web-staging.team.workers.dev',
    )
    expect(via('')).toBe('pr-7-blockly-web-staging.team.workers.dev')
  })

  test('a body goes with it', async () => {
    upstream()
    const sent = toControlPlane(
      new Request('https://cubepals.com/api/auth/sign-in/social', {
        method: 'POST',
        body: '{"provider":"google"}',
      }),
    )
    expect(sent?.method).toBe('POST')
    expect(await sent?.text()).toBe('{"provider":"google"}')
  })

  test('anything else is Next’s, /API included', () => {
    upstream()
    expect(toControlPlane(new Request('https://cubepals.com/servers'))).toBeNull()
    expect(toControlPlane(new Request('https://cubepals.com/API/health'))).toBeNull()
    expect(toControlPlane(new Request('https://cubepals.com/apiary'))).toBeNull()
  })

  // What broke sign-in on the Worker: the control plane's redirect, with the session cookie on it,
  // has to reach the browser rather than be followed on the way.
  test('a redirect and its cookie come back to the browser as they are', async () => {
    const control = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://cubepals.com/servers',
            'set-cookie': 'session=abc; Path=/; HttpOnly',
          },
        }),
    })
    try {
      process.env = { ...saved, API_UPSTREAM: `http://127.0.0.1:${control.port}` }
      const sent = toControlPlane(new Request('https://cubepals.com/api/auth/callback/google?state=s&code=c'))
      const answer = await fetch(sent as Request)
      expect(answer.status).toBe(302)
      expect(answer.headers.get('location')).toBe('https://cubepals.com/servers')
      expect(answer.headers.get('set-cookie')).toContain('session=abc')
    } finally {
      control.stop(true)
    }
  })
})
