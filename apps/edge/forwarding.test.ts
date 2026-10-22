// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { withoutForwarding } from './forwarding.ts'
import { packet, string, varInt } from './notice.ts'

const handshake = (address: string, protocol = 776) =>
  packet(0, [...varInt(protocol), ...string(address), 0x63, 0xdd, 2])
const after = packet(0, string('Alex'))
const join = (address: string) => Uint8Array.from([...handshake(address), ...after])

test('everything after a NUL is cut from the hostname, and what follows the handshake is untouched', () => {
  for (const address of [
    'a.play.test\0^Floodgate^abcdef',
    'a.play.test\x00203.0.113.9\x00069a79f444e94726a5befca90e38aaf5\0[]',
    'a.play.test\0',
  ])
    expect(Array.from(withoutForwarding(join(address)))).toEqual(Array.from(join('a.play.test')))
})

test('a hostname with nothing after it, or only Forge’s marker, is left as it is', () => {
  for (const address of ['a.play.test', 'a.play.test\0FML\0', 'a.play.test\0FML2\0', 'a.play.test\0FML3\0']) {
    const bytes = join(address)
    expect(withoutForwarding(bytes)).toBe(bytes)
  }
})

test('a Forge marker with anything else behind it is cut', () => {
  expect(Array.from(withoutForwarding(join('a.play.test\0FML3\0^Floodgate^x')))).toEqual(
    Array.from(join('a.play.test')),
  )
})

test('bytes that are not a whole handshake come back as they were', () => {
  const half = join('a.play.test\0x').subarray(0, 12)
  expect(withoutForwarding(half)).toBe(half)
  const notHandshake = packet(1, [1, 2, 3])
  expect(withoutForwarding(notHandshake)).toBe(notHandshake)
})
