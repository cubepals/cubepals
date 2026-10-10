// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Production's website values, from the committed example and stand-in values: none of them real. */
import { describe, expect, test } from 'bun:test'
import { ENVIRONMENT_EXAMPLE, environment } from './production-values.ts'
import { productionSite } from './production-website.ts'

const example = environment(ENVIRONMENT_EXAMPLE)
const values = {
  WEB_PROXY_SECRET: 'stand-in-proxy-secret',
  CLOUDFLARE_WORKERS_API_TOKEN: 'stand-in-workers-token',
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
}

describe("production's website", () => {
  test('is built for the production control plane, indexable, at its canonical origin', () => {
    expect(productionSite(values, example)).toEqual({
      apiUpstream: 'https://bly-prod-control.fly.dev',
      canonicalOrigin: 'https://cubepals.com',
      deploymentId: 'prod',
      indexable: true,
      proxySecret: 'stand-in-proxy-secret',
      posthogToken: example.settings.POSTHOG_TOKEN,
      sourceMaps: undefined,
      cloudflare: { token: 'stand-in-workers-token', accountId: '0123456789abcdef0123456789abcdef' },
    })
  })

  test('uploads source maps only with both PostHog values', () => {
    expect(
      productionSite({ ...values, POSTHOG_PERSONAL_API_KEY: 'phx_x' }, example).sourceMaps,
    ).toBeUndefined()
    expect(
      productionSite({ ...values, POSTHOG_PERSONAL_API_KEY: 'phx_x', POSTHOG_PROJECT_ID: '12' }, example)
        .sourceMaps,
    ).toEqual({ key: 'phx_x', project: '12' })
  })
})
