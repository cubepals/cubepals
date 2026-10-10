import { describe, expect, test } from 'bun:test'
import { originAllowed } from '../apps/control/src/interfaces/http/origins.ts'
import { previewAddress } from './lib/web-worker.ts'
import { previewPattern, stagingSite } from './staging-website.ts'

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

  test("reads the preview's address from wrangler's output file", () => {
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
    expect(previewAddress(output)).toBe('https://pr-12-blockly-web-staging.team.workers.dev')
    expect(
      previewAddress(JSON.stringify({ type: 'version-upload', preview_alias_url: null })),
    ).toBeUndefined()
  })
})
