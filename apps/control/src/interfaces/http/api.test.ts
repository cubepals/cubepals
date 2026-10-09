/**
 * The api role's HTTP surface through the real tRPC handler: which pages may send a change, and
 * what reaches PostHog when a request fails.
 */
import { describe, expect, test } from 'bun:test'
import { RecordedInsight } from '../../testing/insight.ts'
import type { Services } from '../trpc/trpc.ts'
import { createApiApp } from './api.ts'

// The gap origins.ts closes, through the real tRPC handler: `billing.portal` takes no input, so a
// form posted from a sibling of the web domain, with the session cookie SameSite lets through,
// would otherwise run it.
describe('a signed-in change with no input', () => {
  const opened: string[] = []
  const app = createApiApp({
    auth: { handle: async () => new Response(null, { status: 404 }), userOf: async () => 'u-1' },
    methods: { google: false, github: false },
    addresses: { proxySecret: null, hostHeader: null },
    origins: ['https://blockly.test'],
    services: {
      billing: {
        customerPortal: async (actor: { userId: string }) => {
          opened.push(actor.userId)
          return { url: 'https://polar.test/portal' }
        },
      },
    } as unknown as Services,
  })
  const portal = (headers: Record<string, string>, body: string | FormData) =>
    app.request('/api/trpc/billing.portal?batch=1', { method: 'POST', headers, body })

  test('runs when Blockly’s own page sends it', async () => {
    const response = await portal(
      { origin: 'https://blockly.test', 'content-type': 'application/json' },
      JSON.stringify({ 0: {} }),
    )
    expect(response.status).toBe(200)
    expect(opened).toEqual(['u-1'])
  })

  test('is refused as a form from a sibling page, and as a form with no page named', async () => {
    const form = new FormData()
    form.set('0', '{}')
    expect((await portal({ origin: 'https://evil.blockly.test' }, form)).status).toBe(403)
    expect((await portal({ 'sec-fetch-site': 'same-site' }, form)).status).toBe(415)
    expect((await portal({}, form)).status).toBe(415)
    expect(opened).toEqual(['u-1'])
  })
})

// What reaches PostHog when the control plane fails a request: the error, the route and the
// request's id, never what the request carried; and feedback is only ever an account's.
describe('errors and feedback', () => {
  const posthog = new RecordedInsight()
  let signedIn: string | null = 'u-1'
  const app = createApiApp({
    auth: { handle: async () => new Response(null, { status: 404 }), userOf: async () => signedIn },
    methods: { google: false, github: false },
    addresses: { proxySecret: null, hostHeader: null },
    origins: ['https://blockly.test'],
    services: {
      billing: {
        customerPortal: async () => {
          throw new Error('the database went away')
        },
      },
      insight: {
        feedback: async () => ({ sent: true }),
        report: (error: unknown, context: Parameters<RecordedInsight['exception']>[1]) =>
          posthog.exception(error, context),
      },
    } as unknown as Services,
  })
  const post = (path: string, body: unknown) =>
    app.request(`/api/trpc/${path}?batch=1`, {
      method: 'POST',
      headers: {
        origin: 'https://blockly.test',
        'content-type': 'application/json',
        'x-request-id': 'req-7',
      },
      body: JSON.stringify({ 0: body }),
    })

  test('a 5xx is reported with its route and request id, and nothing it carried', async () => {
    const response = await post('billing.portal', { secret: 'not for PostHog' })
    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe('req-7')
    expect(posthog.exceptions).toHaveLength(1)
    const [report] = posthog.exceptions
    expect(String(report?.error)).toContain('the database went away')
    expect(report?.distinctId).toBe('u-1')
    expect(report?.properties).toEqual({
      route: 'trpc:billing.portal',
      code: 'INTERNAL_SERVER_ERROR',
      request_id: 'req-7',
    })
    expect(JSON.stringify(report)).not.toContain('not for PostHog')
  })

  test('feedback takes a signed-in account, and a refusal it expects is not an error', async () => {
    signedIn = null
    const response = await post('insight.feedback', { text: 'hi', page: '/', version: 'v' })
    expect(response.status).toBe(401)
    signedIn = 'u-1'
    expect((await post('insight.feedback', { text: 'hi', page: '/', version: 'v' })).status).toBe(200)
    expect(posthog.exceptions).toHaveLength(1)
  })
})
