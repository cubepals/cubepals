// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { browserRedirect, pageFor } from './browser-redirect.ts'

const WEB = 'https://cubepals.test'
const DOMAINS = ['play.cubepals.test', 'mc.cubepals.test']

test('a play address goes to its server’s page', () => {
  expect(pageFor('arcade.play.cubepals.test', DOMAINS, WEB)).toBe(`${WEB}/server/arcade`)
  expect(pageFor('Sunset-Valley.Play.Cubepals.Test', DOMAINS, WEB)).toBe(`${WEB}/server/sunset-valley`)
})

test('an alias of the play domain goes to the same page', () => {
  expect(pageFor('arcade.mc.cubepals.test', DOMAINS, WEB)).toBe(`${WEB}/server/arcade`)
})

test('a port and a final dot are not part of the slug', () => {
  expect(pageFor('arcade.play.cubepals.test:80', DOMAINS, WEB)).toBe(`${WEB}/server/arcade`)
  expect(pageFor('arcade.play.cubepals.test.', DOMAINS, WEB)).toBe(`${WEB}/server/arcade`)
})

test('the bare play domain goes home', () => {
  expect(pageFor('play.cubepals.test', DOMAINS, WEB)).toBe(`${WEB}/`)
})

test('a host under no play domain, or no host at all, goes home', () => {
  expect(pageFor('arcade.example.test', DOMAINS, WEB)).toBe(`${WEB}/`)
  expect(pageFor('evilplay.cubepals.test', DOMAINS, WEB)).toBe(`${WEB}/`)
  expect(pageFor('203.0.113.7', DOMAINS, WEB)).toBe(`${WEB}/`)
  expect(pageFor(null, DOMAINS, WEB)).toBe(`${WEB}/`)
})

test('what can’t be a slug goes home rather than into the path', () => {
  expect(pageFor('a.b.play.cubepals.test', DOMAINS, WEB)).toBe(`${WEB}/`)
  expect(pageFor('-arcade.play.cubepals.test', DOMAINS, WEB)).toBe(`${WEB}/`)
  expect(pageFor('ar_cade.play.cubepals.test', DOMAINS, WEB)).toBe(`${WEB}/`)
})

// ─── Over HTTP ───────────────────────────────────────────────────────────────────────────────

let server: ReturnType<typeof browserRedirect>
const realFetch = globalThis.fetch
/** Every request anything in this process makes over fetch while the listener runs. */
const fetched: string[] = []

beforeAll(() => {
  // A wake, or any other question to the control plane, would go out over fetch.
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return realFetch(input, init)
    },
    { preconnect: realFetch.preconnect },
  )
  server = browserRedirect({ port: 0, hostname: '127.0.0.1', domains: DOMAINS, web: WEB })
})

afterAll(() => {
  server.stop(true)
  globalThis.fetch = realFetch
})

/**
 * Sends `request` as written, so the Host header is exactly the test's, and reads the answer, its
 * header names lowercased.
 */
function ask(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(server.port) })
    let answer = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      answer += chunk.toString()
    })
    socket.on('end', () => resolve(answer.replace(/^[^:\r\n]+:/gm, (name) => name.toLowerCase())))
    socket.on('error', reject)
  })
}

const head = (host: string) => `HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`

test('a browser asking for a play address is redirected to its page at once', async () => {
  const answer = await ask(head('arcade.play.cubepals.test'))
  expect(answer).toStartWith('HTTP/1.1 302')
  expect(answer).toContain(`location: ${WEB}/server/arcade\r\n`)
  expect(answer).toContain('cache-control: no-store\r\n')
})

test('any path and method get the same answer', async () => {
  const answer = await ask(
    'POST /join?x=1 HTTP/1.1\r\nHost: arcade.play.cubepals.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
  )
  expect(answer).toStartWith('HTTP/1.1 302')
  expect(answer).toContain(`location: ${WEB}/server/arcade\r\n`)
})

test('the bare play domain and an unknown host are sent home', async () => {
  expect(await ask(head('play.cubepals.test'))).toContain(`location: ${WEB}/\r\n`)
  expect(await ask(head('somewhere.example.test'))).toContain(`location: ${WEB}/\r\n`)
})

test('no request ever asks anything of the control plane, so none wakes a server', async () => {
  await ask(head('arcade.play.cubepals.test'))
  await ask(head('play.cubepals.test'))
  expect(fetched).toEqual([])
})
