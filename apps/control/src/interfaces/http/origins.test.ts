import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { originAllowed, ownPagesOnly } from './origins.ts'

const OURS = ['https://blockly.test', 'https://pr-*-blockly-web-staging.team.workers.dev']
const JSON_BODY = { 'content-type': 'application/json' }
const app = new Hono()
app.use('/api/trpc/*', ownPagesOnly(OURS))
app.all('/api/trpc/*', (c) => c.text('ran'))
const call = (method: string, origin?: string, headers: Record<string, string> = JSON_BODY) =>
  app.request('/api/trpc/servers.stop', {
    method,
    headers: origin === undefined ? headers : { ...headers, origin },
  })

describe('changes made through the API', () => {
  test('come from Blockly’s own pages and its previews', async () => {
    expect((await call('POST', 'https://blockly.test')).status).toBe(200)
    expect((await call('POST', 'https://pr-12-blockly-web-staging.team.workers.dev')).status).toBe(200)
  })

  test('are refused from another site, which a browser always names', async () => {
    const refused = await call('POST', 'https://evil.test')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'Changes can only be made from Cubepals’ own pages.' })
    // A sibling of Blockly's own domain is the same site, but not one of its pages.
    expect((await call('POST', 'https://other.blockly.test')).status).toBe(403)
    expect((await call('POST', 'null')).status).toBe(403)
  })

  test('are refused when the browser says they came from another site', async () => {
    const crossSite = { ...JSON_BODY, 'sec-fetch-site': 'cross-site' }
    expect((await call('POST', undefined, crossSite)).status).toBe(403)
    expect((await call('POST', 'https://blockly.test', crossSite)).status).toBe(403)
    const sameOrigin = { ...JSON_BODY, 'sec-fetch-site': 'same-origin' }
    expect((await call('POST', 'https://blockly.test', sameOrigin)).status).toBe(200)
  })

  test('are sent as JSON, never as a form any page could post', async () => {
    for (const type of [
      'multipart/form-data; boundary=x',
      'application/x-www-form-urlencoded',
      'text/plain',
    ]) {
      const refused = await call('POST', 'https://blockly.test', { 'content-type': type })
      expect(refused.status).toBe(415)
      expect((await call('POST', undefined, { 'content-type': type })).status).toBe(415)
    }
    expect((await call('POST', 'https://blockly.test', {})).status).toBe(415)
  })

  test('reads, and requests that name no page, are left alone', async () => {
    expect((await call('GET', 'https://evil.test', {})).status).toBe(200)
    expect((await call('POST')).status).toBe(200)
  })

  test('a pattern matches one label, not a path or a longer host', () => {
    expect(originAllowed('https://pr-1-blockly-web-staging.team.workers.dev.evil.test', OURS)).toBe(false)
    expect(originAllowed('https://pr-1.evil-blockly-web-staging.team.workers.dev', OURS)).toBe(false)
  })
})
