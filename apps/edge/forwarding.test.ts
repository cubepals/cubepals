// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the front door passes on of a handshake: no forwarded identity, and no transfer. */
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

const transferred = (address: string, port = [0x63, 0xdd]) =>
  Uint8Array.from([...packet(0, [...varInt(776), ...string(address), ...port, 3]), ...after])

test('a transfer goes on as a plain join, to the same address and port, with what follows untouched', () => {
  expect(Array.from(withoutForwarding(transferred('a.play.test')))).toEqual(Array.from(join('a.play.test')))
  const elsewhere = Uint8Array.from([
    ...packet(0, [...varInt(776), ...string('a.play.test'), 0x01, 0xbb, 2]),
    ...after,
  ])
  expect(Array.from(withoutForwarding(transferred('a.play.test', [0x01, 0xbb])))).toEqual(
    Array.from(elsewhere),
  )
})

test('a transfer that carries forwarding loses both', () => {
  expect(Array.from(withoutForwarding(transferred('a.play.test\0^Floodgate^x')))).toEqual(
    Array.from(join('a.play.test')),
  )
})

test('a transfer from a Forge client keeps its marker and becomes a join', () => {
  expect(Array.from(withoutForwarding(transferred('a.play.test\0FML3\0')))).toEqual(
    Array.from(join('a.play.test\0FML3\0')),
  )
})

test('a ping, and a handshake whose intent does not end it, are left as they are', () => {
  const ping = Uint8Array.from([
    ...packet(0, [...varInt(776), ...string('a.play.test'), 0x63, 0xdd, 1]),
    ...after,
  ])
  expect(withoutForwarding(ping)).toBe(ping)
  const longer = packet(0, [...varInt(776), ...string('a.play.test'), 0x63, 0xdd, 3, 0])
  expect(withoutForwarding(longer)).toBe(longer)
  const cut = packet(0, [...varInt(776), ...string('a.play.test'), 0x63])
  expect(withoutForwarding(cut)).toBe(cut)
})

test('a packet that isn’t a handshake, or one not all here, is left as it is, whatever it carries', () => {
  const looksLike = (id: number) =>
    packet(id, [...varInt(776), ...string('a.play.test\0^Floodgate^x'), 0x63, 0xdd, 3])
  const other = Uint8Array.from([...looksLike(1), ...after])
  expect(withoutForwarding(other)).toBe(other)
  const whole = looksLike(0)
  const short = whole.subarray(0, whole.length - 1)
  expect(withoutForwarding(short)).toBe(short)
  for (const bytes of [Uint8Array.of(5), Uint8Array.of(5, 0), Uint8Array.of(5, 0, 0x80), new Uint8Array(0)])
    expect(withoutForwarding(bytes)).toBe(bytes)
})

test('a handshake that is only its own packet, with nothing after, is rewritten too', () => {
  const alone = packet(0, [...varInt(776), ...string('a.play.test'), 0x63, 0xdd, 3])
  expect(Array.from(withoutForwarding(alone))).toEqual(Array.from(handshake('a.play.test')))
})

test('a hostname the packet’s length ends inside, or right at, is not a handshake to rewrite', () => {
  const host = string('a.play.test\0^Floodgate^x')
  // The length covers the protocol and part of the hostname; the rest follows as if after it.
  const inside = Uint8Array.from([5, 0, ...varInt(776), ...host, 0x63, 0xdd, 3])
  expect(withoutForwarding(inside)).toBe(inside)
  const fields = [...varInt(776), ...host]
  const atEnd = Uint8Array.from([fields.length + 1, 0, ...fields])
  expect(withoutForwarding(atEnd)).not.toBe(atEnd)
})

test('Forge’s marker counts only as the whole of what follows the NUL', () => {
  expect(Array.from(withoutForwarding(join('a.play.test\0x\0FML\0')))).toEqual(
    Array.from(join('a.play.test')),
  )
})
