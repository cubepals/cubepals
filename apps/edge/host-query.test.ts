// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minecraft 26.4's query properties, cut from a handshake's hostname. The handshakes are the bytes a
 * 26.4-snapshot-10 client (protocol 0x4000015c) writes, as its jar lays them out:
 * `ClientIntentionPacket`'s codec is a varint protocol, `stringUtf8(1024)` hostname, unsigned short
 * port and varint intent; the hostname is `ServerConnectionDetails.hostForIntentPacket()`, the
 * resolved host, `?`, then `QueryProperties.asString()`, its keys and values URL-encoded and joined
 * by `&`. `_o` is the address the player typed, `host:port`, added where that differs from what
 * an SRV record resolved it to (`remoteConnection`); `_id` is what came before `@` in it.
 */

import { expect, test } from 'bun:test'
import { withoutForwarding } from './forwarding.ts'
import { queryKeys, withoutQuery } from './host-query.ts'
import { hostnameOf, packet, string, varInt } from './notice.ts'

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))

/** A player typed `mc.example.com`, whose SRV record names `maple-hollow.play.cubepals.com:25565`; joining. */
const SRV_JOIN = bytes(
  '4200dc82808004386d61706c652d686f6c6c6f772e706c61792e6375626570616c732e636f6d3f5f6f3d6d632e6578616d706c652e636f6d253341323535363563dd02',
)
/** The same, from the server list. */
const SRV_PING = bytes(
  '4200dc82808004386d61706c652d686f6c6c6f772e706c61792e6375626570616c732e636f6d3f5f6f3d6d632e6578616d706c652e636f6d253341323535363563dd01',
)
/** A player typed `alex@maple-hollow.play.cubepals.com`; joining. */
const ID_JOIN = bytes(
  '3100dc82808004276d61706c652d686f6c6c6f772e706c61792e6375626570616c732e636f6d3f5f69643d616c657863dd02',
)

/** The handshake a client before 26.4 sent for the same server, for `intent`. */
const plain = (intent: number, address = 'maple-hollow.play.cubepals.com') =>
  packet(0, [...varInt(0x4000015c), ...string(address), 0x63, 0xdd, intent])

const LOGIN_START = packet(0, [...string('Alex'), ...new Uint8Array(16)])
const then = (handshake: Uint8Array) => Uint8Array.from([...handshake, ...LOGIN_START])

test('a join that followed an SRV record routes on the record’s target, as before 26.4', () => {
  expect(hostnameOf({ address: 'maple-hollow.play.cubepals.com?_o=mc.example.com%3A25565' })).toBe(
    'maple-hollow.play.cubepals.com',
  )
  const { bytes: out, keys } = withoutQuery(then(SRV_JOIN))
  expect(Array.from(out)).toEqual(Array.from(then(plain(2))))
  expect(keys).toEqual(['_o'])
})

test('a server list’s ping that followed one is passed on the same way', () => {
  expect(Array.from(withoutQuery(SRV_PING).bytes)).toEqual(Array.from(plain(1)))
})

test('an address typed with an id loses the id: Cubepals sets no allowed-connection-ids, so no server reads it', () => {
  const { bytes: out, keys } = withoutQuery(then(ID_JOIN))
  expect(Array.from(out)).toEqual(Array.from(then(plain(2))))
  expect(keys).toEqual(['_id'])
})

test('a hostname with no query comes back as it was, the same bytes', () => {
  const join = then(plain(2))
  expect(withoutQuery(join)).toEqual({ bytes: join, keys: [] })
})

test('what follows a NUL stays behind the hostname, for the forwarding rules to judge', () => {
  const forge = withoutQuery(plain(2, 'maple-hollow.play.cubepals.com?_id=alex\0FML3\0')).bytes
  expect(Array.from(forge)).toEqual(Array.from(plain(2, 'maple-hollow.play.cubepals.com\0FML3\0')))
  const forged = withoutForwarding(withoutQuery(plain(2, 'a.play.test?_o=x\0^Floodgate^x')).bytes)
  expect(Array.from(forged)).toEqual(Array.from(plain(2, 'a.play.test')))
})

test('a hostname of 1024 characters, the most 26.4 sends, is read and cut', () => {
  const typed = `${'a'.repeat(63)}.example.com`
  const query = `_o=${encodeURIComponent(`${typed}:25565`)}&pad=${'p'.repeat(1024)}`
  const host = `maple-hollow.play.cubepals.com?${query}`.slice(0, 1024)
  expect(host).toHaveLength(1024)
  expect(Array.from(withoutQuery(plain(2, host)).bytes)).toEqual(Array.from(plain(2)))
})

test('keys are read as the game reads them, URL-decoded, and every one is named', () => {
  expect(queryKeys('_id=alex&_o=mc.example.com%3A25565')).toEqual(['_id', '_o'])
  expect(queryKeys('flag&a%5Fb=1&&c+d=2&%zz=3')).toEqual(['flag', 'a_b', 'c d', '%zz'])
})
