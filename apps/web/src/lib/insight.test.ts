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
})
