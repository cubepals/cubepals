// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A script's person gets an account the way the sign-up page gets one: agreeing to the Terms in
 * force, confirmed through the mail, then signed in. The web app and the mail catcher are
 * stand-ins; the stand-in refuses a sign-up as the control plane does, without the agreement.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { connect, createServer, type Server } from 'node:net'
import { signUpAgreementOf, TERMS_VERSION } from '@blockly/contracts'
import { answered } from '@blockly/control/testing/answered'
import { droppedConnection } from './dropped-connection.ts'
import { people } from './people.ts'

const signUps: unknown[] = []
let web: ReturnType<typeof Bun.serve>
let mailpit: ReturnType<typeof Bun.serve>
const mailed = new Map<string, string>()

beforeAll(() => {
  web = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/api/auth/sign-up/email') {
        const body = (await request.json()) as { email: string; agreement?: unknown }
        signUps.push(body)
        if (signUpAgreementOf(body.agreement)?.terms !== TERMS_VERSION)
          return Response.json({ code: 'AGREEMENT_REQUIRED' }, { status: 400 })
        mailed.set(body.email, `Confirm: ${web.url.origin}/api/auth/verify-email?token=t`)
        return Response.json({ token: null })
      }
      if (path === '/api/auth/verify-email') return new Response(null, { status: 302 })
      if (path === '/api/auth/sign-in/email')
        return new Response('{}', { headers: { 'set-cookie': 'session=s; Path=/' } })
      return new Response('not here', { status: 404 })
    },
  })
  mailpit = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/api/v1/search') {
        const to = url.searchParams.get('query')?.match(/to:"(.*)"/)?.[1] ?? ''
        return Response.json({ messages: mailed.has(to) ? [{ ID: to }] : [] })
      }
      return Response.json({ Text: mailed.get(decodeURIComponent(url.pathname.split('/').at(-1) ?? '')) })
    },
  })
})
afterAll(() => {
  web.stop(true)
  mailpit.stop(true)
})

test('signs up agreeing to the Terms in force, as the sign-up page does', async () => {
  const them = await people(web.url.origin, mailpit.url.origin).person('agrees@blockly.test')
  expect(them.email).toBe('agrees@blockly.test')
  expect(signUps.at(-1)).toMatchObject({ agreement: { terms: TERMS_VERSION } })
})

/**
 * The API as a signed-in person calls it, answered by the control plane's own router
 * (`@blockly/control/testing/answered`), behind a door of the test's own that closes its first
 * `drops` connections with no answer, as staging's API did to a nightly's requests.
 */
let router: ReturnType<typeof Bun.serve>
let door: Server
let drops = 0
let asked = 0
const serverId = crypto.randomUUID()
beforeAll(async () => {
  const answer = answered((_service, method) =>
    method === 'get' ? { id: serverId, status: 'running' } : null,
  )
  // Each answer closes its connection, so every call comes to the door anew, as the drops need.
  router = Bun.serve({
    port: 0,
    async fetch(request) {
      const given = await answer(request.url, request)
      const headers = new Headers(given.headers)
      headers.set('connection', 'close')
      return new Response(given.body, { status: given.status, headers })
    },
  })
  door = createServer((socket) => {
    asked += 1
    if (drops > 0) {
      drops -= 1
      return void socket.destroy()
    }
    const behind = connect(Number(router.port), '127.0.0.1')
    socket.pipe(behind).pipe(socket)
  })
  await new Promise<void>((resolve) => door.listen(0, '127.0.0.1', resolve))
})
afterAll(() => {
  door.close()
  router.stop(true)
})

const api = () => people(`http://127.0.0.1:${(door.address() as { port: number }).port}`, '').apiAs(() => '')
const thrownBy = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: unknown) => error,
  )

test('a query whose connection was dropped is asked once more, and no more than once', async () => {
  drops = 1
  asked = 0
  expect(await api()('servers.get', { serverId }, 'GET')).toEqual({ id: serverId, status: 'running' })
  expect(asked).toBe(2)
  drops = 2
  asked = 0
  expect(droppedConnection(await thrownBy(api()('servers.get', { serverId }, 'GET')))).toBe(true)
  expect(asked).toBe(2)
})

test('a change is sent once, even with a requestId, and its dropped connection is the failure', async () => {
  drops = 1
  asked = 0
  const restart = api()('servers.restart', { serverId, requestId: crypto.randomUUID() })
  expect(droppedConnection(await thrownBy(restart))).toBe(true)
  expect(asked).toBe(1)
})
