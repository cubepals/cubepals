// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The PROXY header on the agent's own listeners: read off, and put back for a server that reads one. */

import { expect, test } from 'bun:test'
import { LOCAL_HEADER, proxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { forServer, Unwrap } from './header.ts'
import { statusRequest } from './notice.ts'

const header = proxyHeader({ address: '203.0.113.7', port: 51234 }, { address: '127.0.0.1', port: 25565 })
const ping = statusRequest('a.play.test', 25565)

test('a header is read off, however it is cut, and kept', () => {
  const unwrap = new Unwrap()
  expect(unwrap.take(header.subarray(0, 5))).toBeNull()
  expect(unwrap.take(header.subarray(5, 20))).toBeNull()
  expect(unwrap.take(Uint8Array.from([...header.subarray(20), ...ping.subarray(0, 3)]))).toEqual(
    ping.subarray(0, 3),
  )
  expect(unwrap.take(ping.subarray(3))).toEqual(ping.subarray(3))
  expect(unwrap.header).toEqual(header)
})

test('a connection without one is passed through as it came', () => {
  const unwrap = new Unwrap()
  expect(unwrap.take(ping)).toEqual(ping)
  expect(unwrap.header).toBeNull()
})

test('a server that reads a header gets the one the connection came with, or a LOCAL one', () => {
  expect(forServer(true, header, ping)).toEqual(Uint8Array.from([...header, ...ping]))
  expect(forServer(true, null, ping)).toEqual(Uint8Array.from([...LOCAL_HEADER, ...ping]))
  expect(forServer(false, header, ping)).toEqual(ping)
})
