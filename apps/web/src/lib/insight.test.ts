// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { ENVIRONMENT, stamped } from './insight'

// Every event the browser sends passes through `stamped` on its way out (posthog-js's
// before_send): pageviews, web vitals, autocaptured errors and the ones boundaries report.
describe('browser events', () => {
  test('each carries the environment that built the page, and no address', () => {
    for (const event of ['$pageview', '$pageleave', '$web_vitals', '$exception']) {
      const out = stamped({
        event,
        properties: { $current_url: '/servers', $ip: '203.0.113.9', environment: 'x' },
      })
      expect(out?.properties as Record<string, unknown>).toEqual({
        $current_url: '/servers',
        environment: ENVIRONMENT,
      })
    }
    expect(ENVIRONMENT).toBe('development')
    expect(stamped(null)).toBeNull()
  })

  test('page addresses leave without their query, so an email in one never does', () => {
    const out = stamped({
      event: '$pageview',
      properties: {
        $current_url: 'https://cubepals.com/check-email?email=steve%40example.test',
        $referrer: 'https://example.test/path?token=abc#top',
        $prev_pageview_url: 'https://cubepals.com/sign-up',
        utm_source: 'news',
      },
    })
    expect(out?.properties.$current_url).toBe('https://cubepals.com/check-email')
    expect(out?.properties.$referrer).toBe('https://example.test/path')
    expect(out?.properties.$prev_pageview_url).toBe('https://cubepals.com/sign-up')
    expect(out?.properties.utm_source).toBe('news')
    expect(JSON.stringify(out)).not.toContain('example.test?')
    expect(JSON.stringify(out)).not.toContain('steve')
  })
})
