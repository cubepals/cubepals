import { describe, expect, test } from 'bun:test'
import { connect } from '@nats-io/transport-node'
import type { LogLine } from '../../app/ports/platform.ts'
import { FlyApiError } from './client.ts'
import { FlyLogSource, liveLine, subject } from './fly-logs.ts'
import { encodeHandle } from './handle.ts'
import { flyCredentials } from './token.ts'

const NOW = Date.parse('2026-09-19T12:00:00Z')
const ns = (ms: number) => BigInt(ms) * 1_000_000n
const MINUTE = 60_000

const handleFor = (machineId: string | null) =>
  encodeHandle({
    deployment: 'dev',
    serverId: 's-1',
    app: 'bly-dev-0a1b',
    region: 'ams',
    volumeId: 'vol_1',
    machineId,
    ports: { game: 25565 },
  })

/** Fly's log history as the API answered on 2026-09-19: ascending, after the cursor, paged. */
function history(
  entries: { at: number; provider: string; message: string; instance?: string }[],
  pageSize = 3,
) {
  const requests: URL[] = []
  const fetch = async (url: URL, init: RequestInit) => {
    requests.push(url)
    if (new Headers(init.headers).get('authorization') !== 'FlyV1 fm2_abc')
      return new Response('', { status: 401 })
    const after = BigInt(url.searchParams.get('next_token') || '0')
    const instance = url.searchParams.get('instance')
    const page = entries
      .filter((entry) => ns(entry.at) > after && (instance === null || (entry.instance ?? 'm1') === instance))
      .slice(0, pageSize)
    return Response.json({
      data: page.map((entry) => ({
        id: `0000-${ns(entry.at)}`,
        type: 'logs',
        attributes: {
          timestamp: new Date(entry.at).toISOString(),
          message: entry.message,
          level: 'info',
          instance: entry.instance ?? 'm1',
          region: 'ams',
          meta: { region: 'ams', instance: entry.instance ?? 'm1', event: { provider: entry.provider } },
        },
      })),
      meta: { next_token: page.length ? `${ns(page.at(-1)?.at ?? 0)}` : '' },
    })
  }
  return { fetch, requests }
}

const source = (fetch: ReturnType<typeof history>['fetch']) =>
  new FlyLogSource({ org: 'blockly', token: 'fm2_abc', natsUrl: 'nats://127.0.0.1:1', fetch, now: () => NOW })

describe('Fly credentials', () => {
  test('macaroons go as FlyV1, without the user tokens a flyctl token also carries', () => {
    expect(flyCredentials('fm2_a,fm2_b,fo1_user')).toEqual({
      authorization: 'FlyV1 fm2_a,fm2_b',
      natsPassword: 'fm2_a,fm2_b',
    })
    expect(flyCredentials('FlyV1 fm2_a')).toEqual({ authorization: 'FlyV1 fm2_a', natsPassword: 'fm2_a' })
    expect(flyCredentials('Bearer FlyV1 fm1r_a, fm1a_b')).toEqual({
      authorization: 'FlyV1 fm1r_a,fm1a_b',
      natsPassword: 'fm1r_a,fm1a_b',
    })
  })

  test('anything else goes as Bearer', () => {
    expect(flyCredentials('fo1_user')).toEqual({ authorization: 'Bearer fo1_user', natsPassword: 'fo1_user' })
  })
})

describe('Fly live log lines', () => {
  const payload = (provider: string, message: string, timestamp = '2026-09-19T03:32:42.391729123Z') =>
    JSON.stringify({
      event: { provider },
      fly: { app: { instance: 'm1', name: 'bly-dev-0a1b' }, region: 'ams' },
      host: 'a1b2',
      log: { level: 'info' },
      message,
      timestamp,
    })

  test("the machine's own output, with Fly's nanosecond time", () => {
    expect(liveLine(payload('app', '[12:00:00] [Server thread/INFO]: Done (3.2s)!\n'))).toEqual({
      at: new Date('2026-09-19T03:32:42.391Z'),
      text: '[12:00:00] [Server thread/INFO]: Done (3.2s)!',
    })
  })

  test("Fly's own lines and anything unreadable are not the server's", () => {
    expect(liveLine(payload('proxy', 'could not find a good candidate'))).toBeNull()
    expect(liveLine(payload('runner', 'Machine started in 1.2s'))).toBeNull()
    expect(liveLine('{not json')).toBeNull()
    expect(liveLine(JSON.stringify({ message: 'no provider' }))).toBeNull()
  })

  test('the subject names one machine in any region, and nothing wider', () => {
    expect(subject('bly-dev-0a1b', 'd892175f705048')).toBe('logs.bly-dev-0a1b.*.d892175f705048')
    expect(() => subject('bly-dev-0a1b', '*')).toThrow()
    expect(() => subject('>', 'm1')).toThrow()
    expect(() => subject('bly.dev', 'm1')).toThrow()
  })
})

describe('Fly log history', () => {
  test('reads the last lines of one machine from ten minutes back, page by page', async () => {
    const fake = history([
      { at: NOW - 9 * MINUTE, provider: 'app', message: 'one' },
      { at: NOW - 8 * MINUTE, provider: 'proxy', message: 'not ours' },
      { at: NOW - 7 * MINUTE, provider: 'app', message: 'other machine', instance: 'm2' },
      { at: NOW - 6 * MINUTE, provider: 'app', message: 'two' },
      { at: NOW - 5 * MINUTE, provider: 'app', message: 'three' },
      { at: NOW - 4 * MINUTE, provider: 'app', message: 'four' },
    ])
    const lines = await source(fake.fetch).recent(handleFor('m1'), 3)
    expect(lines.map((line) => line.text)).toEqual(['two', 'three', 'four'])
    expect(lines[2]?.at).toEqual(new Date(NOW - 4 * MINUTE))
    const first = fake.requests[0]
    expect(`${first?.origin}${first?.pathname}`).toBe('https://api.fly.io/api/v1/apps/bly-dev-0a1b/logs')
    expect(first?.searchParams.get('instance')).toBe('m1')
    expect(first?.searchParams.get('next_token')).toBe(`${ns(NOW - 10 * MINUTE)}`)
    // Two full pages, then the empty one that ends it; ten minutes held enough.
    expect(fake.requests).toHaveLength(3)
  })

  test('widens the window only while it holds too few lines', async () => {
    const fake = history([
      { at: NOW - 100 * MINUTE, provider: 'app', message: 'an hour ago' },
      { at: NOW - 5 * MINUTE, provider: 'app', message: 'just now' },
    ])
    const lines = await source(fake.fetch).recent(handleFor('m1'), 2)
    expect(lines.map((line) => line.text)).toEqual(['an hour ago', 'just now'])
    const starts = fake.requests.map((url) => url.searchParams.get('next_token'))
    expect(starts).toContain(`${ns(NOW - 10 * MINUTE)}`)
    expect(starts).toContain(`${ns(NOW - 120 * MINUTE)}`)
    expect(starts).not.toContain(`${ns(NOW - 1440 * MINUTE)}`)
  })

  test('a decommissioned server has no machine and no history', async () => {
    const fake = history([{ at: NOW - MINUTE, provider: 'app', message: 'x' }])
    expect(await source(fake.fetch).recent(handleFor(null), 50)).toEqual([])
    expect(fake.requests).toHaveLength(0)
  })

  test('a refused token is an error, not an empty console', async () => {
    const fake = history([])
    const refused = new FlyLogSource({
      org: 'blockly',
      token: 'fm2_wrong',
      natsUrl: 'nats://127.0.0.1:1',
      fetch: fake.fetch,
    })
    await expect(refused.recent(handleFor('m1'), 10)).rejects.toBeInstanceOf(FlyApiError)
  })
})

// A real NATS server standing in for Fly's log stream:
//   docker run --rm -p 127.0.0.1:4222:4222 nats:2.15.0 --user blockly-test --pass fm2_blockly_test
//   NATS_TEST_URL=nats://127.0.0.1:4222 bun test
const natsUrl = process.env.NATS_TEST_URL
describe.skipIf(!natsUrl)('Fly live logs over NATS', () => {
  const org = 'blockly-test'
  const token = 'fm2_blockly_test'
  const payload = (machine: string, provider: string, message: string) =>
    JSON.stringify({
      event: { provider },
      fly: { app: { instance: machine, name: 'bly-dev-0a1b' }, region: 'ams' },
      log: { level: 'info' },
      message,
      timestamp: new Date().toISOString(),
    })

  async function until(done: () => boolean | Promise<boolean>, what: string) {
    for (let i = 0; i < 100; i++) {
      if (await done()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for ${what}`)
  }

  test("tails one machine's output until stopped", async () => {
    const logs = new FlyLogSource({ org, token, natsUrl: natsUrl ?? '' })
    const publisher = await connect({ servers: natsUrl, user: org, pass: token })
    const controller = new AbortController()
    const seen: LogLine[] = []
    const reading = (async () => {
      for await (const line of logs.tail(handleFor('m1'), controller.signal)) seen.push(line)
      return 'ended'
    })()
    try {
      // The subscription is in place once a probe comes back.
      await until(async () => {
        publisher.publish('logs.bly-dev-0a1b.ams.m1', payload('m1', 'app', 'probe'))
        await publisher.flush()
        return seen.length > 0
      }, 'the subscription')
      seen.length = 0

      publisher.publish('logs.bly-dev-0a1b.ams.m1', payload('m1', 'app', 'first'))
      publisher.publish('logs.bly-dev-0a1b.ams.m1', payload('m1', 'runner', 'Machine started'))
      publisher.publish('logs.bly-dev-0a1b.ams.m2', payload('m2', 'app', 'the export helper'))
      publisher.publish('logs.bly-dev-ffff.ams.m1', payload('m1', 'app', 'another server'))
      publisher.publish('logs.bly-dev-0a1b.ams.m1', '{not json')
      publisher.publish('logs.bly-dev-0a1b.fra.m1', payload('m1', 'app', 'last'))
      await publisher.flush()
      await until(() => seen.some((line) => line.text === 'last'), 'the last line')
      expect(seen.map((line) => line.text).filter((text) => text !== 'probe')).toEqual(['first', 'last'])

      controller.abort()
      expect(await reading).toBe('ended')
    } finally {
      controller.abort()
      await publisher.close()
      await logs.close()
    }
  })

  test('a refused token fails the tail', async () => {
    const logs = new FlyLogSource({ org, token: 'fm2_wrong', natsUrl: natsUrl ?? '' })
    const tail = logs.tail(handleFor('m1'), new AbortController().signal)[Symbol.asyncIterator]()
    await expect(tail.next()).rejects.toThrow(/Authorization/)
    await logs.close()
  })
})
