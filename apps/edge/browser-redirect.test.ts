// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge's answer to a browser: each Host to the page it goes to, and over HTTP, that a browser
 * is answered without the control plane ever being asked, so no server wakes for one.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { browserRedirect, pageFor } from './browser-redirect.ts'

const WEB = 'https://cubepals.test'
/** Routes name a server's address under the play domain and under each alias. */
const SERVERS = new Set([
  'arcade.play.cubepals.test',
  'arcade.mc.cubepals.test',
  'castle-builders.play.cubepals.test',
  'sunset-valley.play.cubepals.test',
  'sunset-valley.mc.cubepals.test',
])
/** A kept address's routes say which server it points at. */
const ALIASES = new Map([
  ['sunset-valley.play.cubepals.test', 'arcade'],
  ['sunset-valley.mc.cubepals.test', 'arcade'],
])
const PAGES = {
  domains: ['play.cubepals.test', 'mc.cubepals.test'],
  web: WEB,
  known: (name: string) => SERVERS.has(name),
  aliasOf: (name: string) => ALIASES.get(name),
}

test('a play address goes to its server’s page', () => {
  expect(pageFor('arcade.play.cubepals.test', PAGES)).toBe(`${WEB}/server/arcade`)
  expect(pageFor('Castle-Builders.Play.Cubepals.Test', PAGES)).toBe(`${WEB}/server/castle-builders`)
})

test('a kept address goes to the page of the server it points at, under every play domain', () => {
  expect(pageFor('sunset-valley.play.cubepals.test', PAGES)).toBe(`${WEB}/server/arcade`)
  expect(pageFor('Sunset-Valley.MC.Cubepals.Test.', PAGES)).toBe(`${WEB}/server/arcade`)
})

test('an alias of the play domain goes to the same page', () => {
  expect(pageFor('arcade.mc.cubepals.test', PAGES)).toBe(`${WEB}/server/arcade`)
})

test('a port and a final dot are not part of the slug', () => {
  expect(pageFor('arcade.play.cubepals.test:80', PAGES)).toBe(`${WEB}/server/arcade`)
  expect(pageFor('arcade.play.cubepals.test.', PAGES)).toBe(`${WEB}/server/arcade`)
})

test('the bare play domain goes home', () => {
  expect(pageFor('play.cubepals.test', PAGES)).toBe(`${WEB}/`)
})

test('an address no server has goes home', () => {
  expect(pageFor('nothing-here.play.cubepals.test', PAGES)).toBe(`${WEB}/`)
})

test('Cubepals’ example address goes home, under every play domain', () => {
  expect(pageFor('your-server.play.cubepals.test', PAGES)).toBe(`${WEB}/`)
  expect(pageFor('Your-Server.MC.Cubepals.Test.', PAGES)).toBe(`${WEB}/`)
})

test('a host under no play domain, or no host at all, goes home', () => {
  expect(pageFor('arcade.example.test', PAGES)).toBe(`${WEB}/`)
  expect(pageFor('evilplay.cubepals.test', PAGES)).toBe(`${WEB}/`)
  expect(pageFor('203.0.113.7', PAGES)).toBe(`${WEB}/`)
  expect(pageFor(null, PAGES)).toBe(`${WEB}/`)
})

test('what can’t be a slug goes home rather than into the path', () => {
  expect(pageFor('a.b.play.cubepals.test', PAGES)).toBe(`${WEB}/`)
  expect(pageFor('-arcade.play.cubepals.test', PAGES)).toBe(`${WEB}/`)
  expect(pageFor('ar_cade.play.cubepals.test', PAGES)).toBe(`${WEB}/`)
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
  server = browserRedirect({ port: 0, hostname: '127.0.0.1', ...PAGES })
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

test('a browser asking for a kept address is redirected to its server’s page', async () => {
  const answer = await ask(head('sunset-valley.play.cubepals.test'))
  expect(answer).toStartWith('HTTP/1.1 302')
  expect(answer).toContain(`location: ${WEB}/server/arcade\r\n`)
})

test('any path and method get the same answer', async () => {
  const answer = await ask(
    'POST /join?x=1 HTTP/1.1\r\nHost: arcade.play.cubepals.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
  )
  expect(answer).toStartWith('HTTP/1.1 302')
  expect(answer).toContain(`location: ${WEB}/server/arcade\r\n`)
})

test('the bare play domain, an unknown address and an unknown host are sent home', async () => {
  expect(await ask(head('play.cubepals.test'))).toContain(`location: ${WEB}/\r\n`)
  expect(await ask(head('nothing-here.play.cubepals.test'))).toContain(`location: ${WEB}/\r\n`)
  expect(await ask(head('somewhere.example.test'))).toContain(`location: ${WEB}/\r\n`)
})

test('no request ever asks anything of the control plane, so none wakes a server', async () => {
  await ask(head('arcade.play.cubepals.test'))
  await ask(head('sunset-valley.play.cubepals.test'))
  await ask(head('play.cubepals.test'))
  expect(fetched).toEqual([])
})

test('the edge’s health is Java’s alone: Bedrock down, or never started, never changes it', async () => {
  let bedrock: { state: string; bound: boolean; restarts: number } | null = {
    state: 'down',
    bound: false,
    restarts: 3,
  }
  const server = browserRedirect({ ...PAGES, port: 0, hostname: '127.0.0.1', bedrock: () => bedrock })
  try {
    const at = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: 'manual' })
    expect((await at('/_health')).status).toBe(204)
    const down = await at('/_health/bedrock')
    expect(down.status).toBe(503)
    expect(await down.json()).toEqual({ state: 'down', bound: false, restarts: 3 })
    bedrock = { state: 'up', bound: true, restarts: 3 }
    expect((await at('/_health/bedrock')).status).toBe(200)
    bedrock = null
    expect((await at('/_health/bedrock')).status).toBe(404)
    expect((await at('/_health')).status).toBe(204)
  } finally {
    await server.stop(true)
  }
})

test('the drain status is not served here: its path is redirected like any other', async () => {
  const answer = await ask(
    'GET /_health/drain HTTP/1.1\r\nHost: arcade.play.cubepals.test\r\nConnection: close\r\n\r\n',
  )
  expect(answer).toStartWith('HTTP/1.1 302')
  expect(answer).toContain(`location: ${WEB}/server/arcade\r\n`)
  expect(answer).not.toContain('players')
})

test('the edge’s health fails until it holds routes, then stays well', async () => {
  let held = false
  const server = browserRedirect({ ...PAGES, port: 0, hostname: '127.0.0.1', holdsRoutes: () => held })
  try {
    const at = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: 'manual' })
    expect((await at('/_health')).status).toBe(503)
    held = true
    expect((await at('/_health')).status).toBe(204)
  } finally {
    await server.stop(true)
  }
})
