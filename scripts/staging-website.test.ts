// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Staging's website and its previews: values, trusted addresses, the router's routes, the upload. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { originAllowed } from '../apps/control/src/interfaces/http/origins.ts'
import { previewUpload, routerConfig } from './lib/web-worker.ts'
import {
  aliasSuffix,
  brandedCommit,
  brandedPreview,
  COMMIT_PATTERN,
  PREVIEW_DOMAIN,
  previewPattern,
  stagingSite,
  workersSubdomain,
} from './staging-website.ts'

const CLOUDFLARE = { token: 'stand-in', accountId: 'stand-in' }

describe("staging's website and its previews", () => {
  test('builds with staging’s values, and keeps the Worker’s secret when given none', () => {
    const site = stagingSite(CLOUDFLARE)
    expect(site).toMatchObject({
      env: 'staging',
      apiUpstream: 'https://bly-staging-control.fly.dev',
      canonicalOrigin: 'https://staging.cubepals.com',
      deploymentId: 'staging',
      indexable: false,
    })
    expect(site.proxySecret).toBeUndefined()
    expect(stagingSite(CLOUDFLARE, 'stand-in-secret').proxySecret).toBe('stand-in-secret')
  })

  test("trusts every pull request's address on the account's subdomain, and only those", () => {
    const pattern = previewPattern('team')
    expect(pattern).toBe('https://pr-*-blockly-web-staging.team.workers.dev')
    const matches = (origin: string) => originAllowed(origin, [pattern])
    expect(matches('https://pr-12-blockly-web-staging.team.workers.dev')).toBe(true)
    expect(matches('https://pr-12-blockly-web.team.workers.dev')).toBe(false)
    expect(matches('https://pr-12-blockly-web-staging.other.workers.dev')).toBe(false)
  })

  test("trusts every pull request's branded address, and only those", () => {
    const pattern = brandedPreview('*')
    expect(pattern).toBe('https://pr-*.preview.cubepals.com')
    expect(brandedPreview('12')).toBe('https://pr-12.preview.cubepals.com')
    const matches = (origin: string) => originAllowed(origin, [pattern])
    expect(matches('https://pr-12.preview.cubepals.com')).toBe(true)
    expect(matches('https://preview.cubepals.com')).toBe(false)
    expect(matches('https://pr-12.preview.cubepals.com.example')).toBe(false)
    expect(previewPattern('team')).toBe(`https://pr-*${aliasSuffix('team')}`)
  })

  test("trusts each commit's branded address by its shape, and only those", () => {
    expect(brandedCommit('b226b58a0c1d2e3f')).toBe('https://b226b58.preview.cubepals.com')
    expect(COMMIT_PATTERN).toBe('https://???????.preview.cubepals.com')
    const matches = (origin: string) => originAllowed(origin, [COMMIT_PATTERN])
    expect(matches(brandedCommit('b226b58a0c1d2e3f'))).toBe(true)
    expect(matches('https://pr-12.preview.cubepals.com')).toBe(false)
    expect(matches('https://b226b58a.preview.cubepals.com')).toBe(false)
    expect(matches('https://b2.6b58.preview.cubepals.com')).toBe(false)
  })

  test("routes the previews' router where the previews are", () => {
    const config = readFileSync(join(import.meta.dir, '../apps/web/preview-router.jsonc'), 'utf8')
    const routes = (JSON.parse(config.replace(/^\s*\/\/.*$/gm, '')) as { routes: { pattern: string }[] })
      .routes
    expect(routes.map((route) => route.pattern)).toEqual([PREVIEW_DOMAIN, `*.${PREVIEW_DOMAIN}/*`])
  })

  test("deploys the router bound to the commits' namespace, its entry found from anywhere", () => {
    const config = readFileSync(join(import.meta.dir, '../apps/web/preview-router.jsonc'), 'utf8')
    const deployed = routerConfig(config, 'namespace-id')
    expect(deployed.kv_namespaces).toEqual([{ binding: 'COMMITS', id: 'namespace-id' }])
    expect(deployed.main).toBe(join(import.meta.dir, '../apps/web/preview-router.ts'))
    expect(deployed.name).toBe('blockly-web-previews')
    expect(deployed.$schema).toBeUndefined()
  })

  test("reads the preview's address and version from wrangler's output file", () => {
    const output = [
      JSON.stringify({ type: 'wrangler-session', version: 1 }),
      JSON.stringify({
        type: 'version-upload',
        version_id: 'v',
        preview_url: 'https://0123abcd-blockly-web-staging.team.workers.dev',
        preview_alias_url: 'https://pr-12-blockly-web-staging.team.workers.dev',
      }),
      '',
    ].join('\n')
    expect(previewUpload(output)).toEqual({
      url: 'https://pr-12-blockly-web-staging.team.workers.dev',
      version: 'v',
      versionUrl: 'https://0123abcd-blockly-web-staging.team.workers.dev',
    })
    expect(
      previewUpload(JSON.stringify({ type: 'version-upload', version_id: 'v', preview_alias_url: null })),
    ).toEqual({ url: undefined, version: 'v', versionUrl: undefined })
  })
})

describe("the account's workers.dev subdomain", () => {
  /** A stand-in for Cloudflare's API that gives `answers` in turn, and counts what was asked and waited. */
  const cloudflareSaying = (...answers: (object | Error)[]) => {
    const seen = { asks: 0, pauses: [] as number[] }
    const ask = (async () => {
      const answer = answers[Math.min(seen.asks++, answers.length - 1)]
      if (answer instanceof Error) throw answer
      return Response.json(answer, { status: 'success' in answer && answer.success ? 200 : 500 })
    }) as unknown as typeof fetch
    const pause = async (ms: number) => void seen.pauses.push(ms)
    return { seen, ask, pause }
  }
  const NONE = { success: false, errors: [{ code: 10000, message: 'Internal error' }], result: null }
  const NAMED = { success: true, errors: [], result: { subdomain: 'cubepals' } }

  test('is asked again, a little later each time, when Cloudflare answers without one', async () => {
    const { seen, ask, pause } = cloudflareSaying(NONE, new Error('socket hang up'), NAMED)
    expect(await workersSubdomain(CLOUDFLARE, ask, pause)).toBe('cubepals')
    expect(seen.asks).toBe(3)
    expect(seen.pauses).toEqual([5000, 10000])
  })

  test('fails with what Cloudflare last said once it never names one', async () => {
    const { seen, ask, pause } = cloudflareSaying(NONE)
    await expect(workersSubdomain(CLOUDFLARE, ask, pause)).rejects.toThrow(
      'asked 4 times: HTTP 500 [{"code":10000,"message":"Internal error"}]',
    )
    expect(seen.asks).toBe(4)
  })
})
