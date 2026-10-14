// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { flyClient } from './client.ts'

/** A Fly that refuses with 429 `refusals` times, then answers, noting when each call came. */
function throttling(refusals: number, retryAfter: string | null) {
  const at: number[] = []
  const fetch = async () => {
    at.push(Date.now())
    if (at.length > refusals) return Response.json({ name: 'bly-test' })
    return new Response('rate limit exceeded', {
      status: 429,
      headers: retryAfter === null ? {} : { 'retry-after': retryAfter },
    })
  }
  return { at, fetch }
}

const getApp = (fly: ReturnType<typeof throttling>) =>
  flyClient('token', { fetch: fly.fetch as never, pace: { perSecond: 1000, burst: 1000 } }).GET(
    '/v1/apps/{app_name}',
    { params: { path: { app_name: 'bly-test' } } },
  )

describe('the Fly client, refused for going too fast', () => {
  test('without a Retry-After, it waits longer after each refusal, then gets through', async () => {
    const fly = throttling(2, null)
    const { response } = await getApp(fly)
    expect(response.status).toBe(200)
    expect(fly.at).toHaveLength(3)
    const [first = 0, second = 0, third = 0] = fly.at
    expect(second - first).toBeGreaterThanOrEqual(450)
    expect(third - second).toBeGreaterThanOrEqual(950)
  }, 10_000)

  test('a refusal that goes on is handed back after five tries, for the queue to try again later', async () => {
    const fly = throttling(Number.POSITIVE_INFINITY, '0.01')
    const { response } = await getApp(fly)
    expect(response.status).toBe(429)
    expect(fly.at).toHaveLength(5)
  })
})
