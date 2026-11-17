// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A script's person gets an account the way the sign-up page gets one: agreeing to the Terms in
 * force, confirmed through the mail, then signed in. The web app and the mail catcher are
 * stand-ins; the stand-in refuses a sign-up as the control plane does, without the agreement.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { signUpAgreementOf, TERMS_VERSION } from '@blockly/contracts'
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
 * The API as a signed-in person calls it, against a server of the test's own that closes its first
 * `drops` connections with no answer, as staging's API did to a stop, and then answers as tRPC does.
 */
let dropping: Server
let drops = 0
let asked = 0
beforeAll(async () => {
  dropping = createServer((socket) => {
    asked += 1
    if (drops > 0) {
      drops -= 1
      return void socket.destroy()
    }
    const body = JSON.stringify([{ result: { data: { ok: true } } }])
    socket.once('data', () =>
      socket.end(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`),
    )
  })
  await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve))
})
afterAll(() => dropping.close())

const apiOnDropping = () => {
  const { port } = dropping.address() as { port: number }
  return people(`http://127.0.0.1:${port}`, '').apiAs(() => '')
}
const thrownBy = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: unknown) => error,
  )

test('a query whose connection was dropped is asked once more', async () => {
  drops = 1
  asked = 0
  expect(await apiOnDropping()('servers.get', { serverId: 's' }, 'GET')).toEqual({ ok: true })
  expect(asked).toBe(2)
})

test('a change keyed by its requestId is sent once more after a drop, and no more than once', async () => {
  drops = 1
  asked = 0
  expect(await apiOnDropping()('servers.stop', { serverId: 's', requestId: 'r' })).toEqual({ ok: true })
  expect(asked).toBe(2)
  drops = 2
  asked = 0
  expect(
    droppedConnection(await thrownBy(apiOnDropping()('servers.stop', { serverId: 's', requestId: 'r' }))),
  ).toBe(true)
  expect(asked).toBe(2)
})

test('a change without a requestId is sent once, and its dropped connection is the failure', async () => {
  drops = 1
  asked = 0
  expect(droppedConnection(await thrownBy(apiOnDropping()('servers.delete', { serverId: 's' })))).toBe(true)
  expect(asked).toBe(1)
})
