// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What a running edge says of its routes, as the control plane answers its polls or doesn't. */
import { expect, test } from 'bun:test'
import { ROUTES_HELD_HEADER, ROUTES_VERSION_HEADER } from '../../packages/contracts/src/edge-poll.ts'
import { RoutesPoll } from './poll.ts'

const list = () =>
  new Response(JSON.stringify({ routes: [] }), {
    headers: { etag: '"a"', [ROUTES_VERSION_HEADER]: '1' },
  })

test('holds routes once a list is applied, and keeps doing so while the control plane is unreachable', async () => {
  let answer: () => Promise<Response> = async () => list()
  const poll = new RoutesPoll(
    () => answer(),
    async () => true,
  )
  expect(poll.heldOnce()).toBe(false)
  expect(poll.current()).toBe(false)

  await poll.sync()
  expect(poll.heldOnce()).toBe(true)
  expect(poll.current()).toBe(true)

  answer = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  await expect(poll.sync()).rejects.toThrow('ECONNREFUSED')
  answer = async () => new Response(null, { status: 503 })
  await expect(poll.sync()).rejects.toThrow('503')
  expect(poll.heldOnce()).toBe(true)
})

test('is not held while the first list is not applied', async () => {
  const poll = new RoutesPoll(
    async () => list(),
    async () => false,
  )
  await poll.sync()
  expect(poll.heldOnce()).toBe(false)
})

test('an unchanged answer moves the version it says to that answer’s, so a change finds it current', async () => {
  const asked: Record<string, string>[] = []
  let answer = async () => list()
  const poll = new RoutesPoll(
    async (headers) => {
      asked.push(headers)
      return answer()
    },
    async () => true,
  )
  const unchanged = (version?: string) => async () =>
    new Response(null, {
      status: 304,
      headers: version === undefined ? {} : { [ROUTES_VERSION_HEADER]: version },
    })

  expect(await poll.sync()).toBe(true)
  answer = unchanged('5')
  expect(await poll.sync()).toBe(false)
  // A 304 with no version, an older one or one that isn't a number keeps the newest it was told.
  for (const version of [undefined, '3', 'later']) {
    answer = unchanged(version)
    await poll.sync()
  }
  // The list changes: the ask that finds out says the version it held until then, not the first list's.
  answer = async () => list()
  await poll.sync()
  expect(asked.slice(2).map((headers) => headers[ROUTES_HELD_HEADER])).toEqual(['5', '5', '5', '5'])
})

test('a 304 before any list is held says no version', async () => {
  const asked: Record<string, string>[] = []
  const poll = new RoutesPoll(
    async (headers) => {
      asked.push(headers)
      return new Response(null, { status: 304, headers: { [ROUTES_VERSION_HEADER]: '5' } })
    },
    async () => true,
  )
  await poll.sync()
  await poll.sync()
  expect(poll.heldOnce()).toBe(false)
  expect(asked.map((headers) => headers[ROUTES_HELD_HEADER])).toEqual([undefined, undefined])
})
