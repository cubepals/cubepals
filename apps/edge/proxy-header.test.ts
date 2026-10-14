// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** PROXY protocol v2 headers: the bytes the specification lays out, and reading them back. */

import { expect, test } from 'bun:test'
import { LOCAL_HEADER, proxyHeader, readProxyHeader } from '../../packages/contracts/src/proxy-header.ts'

/** The signature, from § 2.2 of https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt. */
const SIGNATURE = '0d0a0d0a000d0a515549540a'
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

test('an IPv4 connection: version 2 PROXY, TCP over IPv4, 12 bytes of addresses and ports', () => {
  const header = proxyHeader({ address: '203.0.113.7', port: 51234 }, { address: '127.0.0.1', port: 25565 })
  // Signature, version and command, family, length, source, destination, their ports.
  expect(hex(header)).toBe([SIGNATURE, '21', '11', '000c', 'cb007107', '7f000001', 'c822', '63dd'].join(''))
  expect(readProxyHeader(header)).toEqual({ source: { address: '203.0.113.7', port: 51234 }, next: 28 })
})

test('an IPv6 connection: TCP over IPv6, 36 bytes, with `::` and an IPv4 tail written out', () => {
  const header = proxyHeader({ address: '64:ff9b::203.0.113.7', port: 1 }, { address: '::1', port: 2 })
  expect(hex(header)).toBe(
    [
      SIGNATURE,
      '21',
      '21',
      '0024',
      '0064ff9b0000000000000000cb007107',
      '00000000000000000000000000000001',
      '0001',
      '0002',
    ].join(''),
  )
  expect(readProxyHeader(header)).toEqual({
    source: { address: '64:ff9b:0:0:0:0:cb00:7107', port: 1 },
    next: 52,
  })
})

test('an IPv4 address in IPv6 form is written as IPv4', () => {
  const header = proxyHeader({ address: '::ffff:203.0.113.7', port: 1 }, { address: '127.0.0.1', port: 2 })
  expect(header[13]).toBe(0x11)
})

test('a LOCAL header names nobody', () => {
  expect(hex(LOCAL_HEADER)).toBe(`${SIGNATURE}20000000`)
  expect(readProxyHeader(LOCAL_HEADER)).toEqual({ source: null, next: 16 })
})

test('a Minecraft handshake is no header, and a header cut short may still be one', () => {
  // A handshake of 13 bytes opens with the signature's first byte, and parts at the second.
  expect(readProxyHeader(Uint8Array.from([0x0d, 0x00, 0xff]))).toBe('none')
  expect(readProxyHeader(Uint8Array.from([0xfe, 0x01]))).toBe('none')
  expect(readProxyHeader(Uint8Array.from([0x0d]))).toBe('more')
  expect(readProxyHeader(LOCAL_HEADER.subarray(0, 15))).toBe('more')
  const header = proxyHeader({ address: '203.0.113.7', port: 1 }, { address: '127.0.0.1', port: 2 })
  expect(readProxyHeader(header.subarray(0, 20))).toBe('more')
  expect(readProxyHeader(Uint8Array.from([...header.subarray(0, 12), 0x11, 0x11, 0, 0]))).toBe('bad')
})

test('an address no client has is refused at once, however long', () => {
  const to = { address: '::1', port: 2 }
  const started = performance.now()
  for (const address of ['%'.repeat(100_000), `1${'9'.repeat(100_000)}`, `::${'9.'.repeat(50_000)}`, ':::'])
    expect(() => proxyHeader({ address: `2001:db8::${address}`, port: 1 }, to)).toThrow()
  expect(() =>
    proxyHeader({ address: `${'9'.repeat(100_000)}.1.1.1`, port: 1 }, { address: '127.0.0.1', port: 2 }),
  ).toThrow()
  expect(performance.now() - started).toBeLessThan(100)
  // A zone names the interface, and is left out.
  expect(readProxyHeader(proxyHeader({ address: 'fe80::1%eth0', port: 1 }, to))).toMatchObject({
    source: { address: 'fe80:0:0:0:0:0:0:1' },
  })
})
