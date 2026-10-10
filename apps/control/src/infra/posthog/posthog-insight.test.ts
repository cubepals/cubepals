// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The PostHog adapter through the real SDK, against a stand-in for PostHog's endpoint: every event
 * carries its environment, and a refused send says so without throwing.
 */
import { describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { PostHogInsight } from './posthog-insight.ts'

/** What the SDK posted, read back as PostHog would: each event in each batch, unzipped. */
function standIn(status = 200) {
  const events: Array<{ event: string; distinct_id?: string; properties: Record<string, unknown> }> = []
  const fetch = async (_url: string, options: { body?: unknown }) => {
    const raw = options.body
    const text = typeof raw === 'string' ? raw : gunzipSync(Buffer.from(raw as Uint8Array)).toString('utf8')
    const body = JSON.parse(text) as { batch?: typeof events }
    events.push(...(body.batch ?? []))
    return {
      status,
      text: async () => '{"status":"Ok"}',
      json: async () => ({ status: 'Ok' }),
      headers: { get: () => null },
    }
  }
  return { events, fetch }
}

// The adapter against a stand-in for PostHog's endpoint, through the real SDK: every way an event
// leaves the control plane says which environment sent it, so staging and local stay out of
// production's charts.
describe('PostHog insight', () => {
  test('every capture path carries the environment', async () => {
    const posthog = standIn()
    const insight = new PostHogInsight({
      token: 'phc_test',
      host: 'https://posthog.test',
      environment: 'staging',
      fetch: posthog.fetch as never,
    })
    expect(await insight.send({ distinctId: 'u-1', event: 'signed_up', properties: {} })).toBe(true)
    insight.capture({ distinctId: 'u-1', event: 'survey shown', properties: { moment: 'm' } })
    insight.exception(new Error('boom'), { distinctId: 'u-1', properties: { route: 'trpc:servers.get' } })
    await insight.shutdown()
    expect(posthog.events.map((e) => e.event).sort()).toEqual(['$exception', 'signed_up', 'survey shown'])
    for (const event of posthog.events) expect(event.properties.environment).toBe('staging')
    expect(posthog.events.find((e) => e.event === '$exception')?.properties.route).toBe('trpc:servers.get')
  })

  test('a send PostHog refuses answers false, and throws nothing', async () => {
    const posthog = standIn(500)
    const insight = new PostHogInsight({
      token: 'phc_test',
      host: 'https://posthog.test',
      environment: 'production',
      fetch: posthog.fetch as never,
    })
    expect(await insight.send({ distinctId: 'u-1', event: 'survey sent', properties: {} })).toBe(false)
    await insight.shutdown()
  })
})
