// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The check a Worker build must pass before it deploys: robots.txt and the /api rewrite, for its environment. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProblems, type WorkerSite } from './web-worker.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true })
})

/** A `.next` directory as `next build` leaves it, with this robots.txt and this rewrite target. */
function built(robots: string, upstream: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-worker-test-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'server/app'), { recursive: true })
  writeFileSync(join(dir, 'server/app/robots.txt.body'), robots)
  const rewrite = { source: '/api/:path*', destination: `${upstream}/api/:path*`, regex: '^/api' }
  writeFileSync(
    join(dir, 'routes-manifest.json'),
    JSON.stringify({ rewrites: { beforeFiles: [], afterFiles: [rewrite], fallback: [] } }),
  )
  return dir
}

const site = (indexable: boolean, apiUpstream: string): WorkerSite => ({
  apiUpstream,
  canonicalOrigin: 'https://cubepals.com',
  deploymentId: indexable ? 'prod' : 'staging',
  indexable,
  proxySecret: 'stand-in',
  cloudflare: { token: 'stand-in', accountId: 'stand-in' },
})
const OPEN = 'User-Agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://cubepals.com/sitemap.xml\n'
const CLOSED = 'User-Agent: *\nDisallow: /\n'
const PROD = 'https://bly-prod-control.fly.dev'
const STAGING = 'https://bly-staging-control.fly.dev'

describe("a build checked against its environment's values", () => {
  test("production's build lets crawlers in and sends /api to production", () => {
    expect(buildProblems(site(true, PROD), built(OPEN, PROD))).toEqual([])
  })

  test("staging's build turns crawlers away and sends /api to staging", () => {
    expect(buildProblems(site(false, STAGING), built(CLOSED, STAGING))).toEqual([])
  })

  test('a build made with the other environment’s values never passes', () => {
    expect(buildProblems(site(true, PROD), built(CLOSED, STAGING))).toEqual([
      'robots.txt turns search engines away',
      `/api goes to ${STAGING}/api/:path*, not ${PROD}`,
    ])
    expect(buildProblems(site(false, STAGING), built(OPEN, STAGING))).toEqual([
      'robots.txt lets search engines in',
    ])
  })
})
