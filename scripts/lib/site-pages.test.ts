// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What counts as a page being up, against a real local server that answers as a broken Worker would. */
import { afterAll, expect, describe as group, test } from 'bun:test'
import { tailExceptions } from '../site-uptime.ts'
import {
  ask,
  isUp,
  PRODUCTION_OTHERS,
  realtimeTarget,
  SITE_PAGES,
  waitFor,
  websiteTargets,
} from './site-pages.ts'

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/pricing') return new Response('error code: 1101', { status: 500 })
    if (path === '/sign-in') return Response.redirect('/elsewhere', 302)
    return new Response('ok')
  },
})
afterAll(() => server.stop(true))
const origin = `http://127.0.0.1:${server.port}`

group('the website’s pages', () => {
  test('a 500 fails, a redirect and a 200 pass', async () => {
    const answers = await ask(websiteTargets(origin))
    expect(answers.map((a) => [a.target.name, a.status, isUp(a)])).toEqual([
      ['/', 200, true],
      ['/pricing', 500, false],
      ['/sign-in', 302, true],
      ['/browse', 200, true],
    ])
  })

  test('an address nothing listens on is down, with the reason', async () => {
    const [answer] = await ask(websiteTargets('http://127.0.0.1:1').slice(0, 1))
    expect(answer?.status).toBe(0)
    expect(isUp(answer as never)).toBe(false)
    expect(answer?.error).toBeTruthy()
  })

  test('waitFor gives up after its time and names what failed', async () => {
    const lines: string[] = []
    const { failing } = await waitFor(websiteTargets(origin), 0, (line) => lines.push(line))
    expect(failing.map((a) => a.target.name)).toEqual(['/pricing'])
    expect(lines[0]).toContain('/pricing 500')
  })

  test('all four pages are asked', () => {
    expect(SITE_PAGES).toEqual(['/', '/pricing', '/sign-in', '/browse'])
  })
})

group('the other public addresses', () => {
  const [hq, webtransport, websocket] = PRODUCTION_OTHERS
  test('hq is well when it redirects', () => {
    expect([hq?.ok(302), hq?.ok(200), hq?.ok(500)]).toEqual([true, false, false])
  })

  test('realtime is asked over each transport, and a plain answer from its host is not enough', () => {
    expect([webtransport?.name, websocket?.name]).toEqual([
      'rt.cubepals.com over WebTransport',
      'rt.cubepals.com over WebSocket',
    ])
    expect([webtransport?.ok(200), webtransport?.ok(404), webtransport?.ok(0)]).toEqual([true, false, false])
    expect([websocket?.ok(101), websocket?.ok(404), websocket?.ok(0)]).toEqual([true, false, false])
  })

  test('realtime that doesn’t answer is down, with what the check heard', async () => {
    const [answer] = await ask([realtimeTarget('websocket', '127.0.0.1:1')])
    expect(answer?.status).toBe(0)
    expect(isUp(answer as never)).toBe(false)
    expect(answer?.error).toStartWith('no handshake')
  }, 20_000)
})

group('a Worker tail', () => {
  test('exceptions are read from its JSON lines, once each', () => {
    const event = JSON.stringify({
      exceptions: [
        { name: 'Error', message: 'Unexpected loadManifest(/.next/server/preview-props.json) call!' },
      ],
    })
    expect(tailExceptions(`${event}\nnot json\n${event}\n`)).toEqual([
      'Error: Unexpected loadManifest(/.next/server/preview-props.json) call!',
    ])
  })
})
