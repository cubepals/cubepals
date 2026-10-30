// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** TCP segmentation must neither leak PROXY headers to Minecraft nor drop, duplicate or reinterpret payload bytes. */

import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { LOCAL_HEADER, proxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { forServer, Unwrap } from './header.ts'

const properties = { seed: 0x706178, numRuns: 150, includeErrorInReport: true }

test('every segmentation preserves the exact payload and the original header', () => {
  fc.assert(
    fc.property(
      fc.ipV4(),
      fc.ipV4(),
      fc.uint8Array({ maxLength: 150 }),
      fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 30 }),
      (source, destination, payload, chunks) => {
        const header = proxyHeader({ address: source, port: 51234 }, { address: destination, port: 25565 })
        const stream = Uint8Array.from([...header, ...payload])
        const unwrap = new Unwrap()
        const delivered: number[] = []
        let offset = 0
        for (const size of [...chunks, stream.length]) {
          const chunk = stream.subarray(offset, offset + size)
          const read = unwrap.take(chunk)
          expect(read).not.toBe('bad')
          if (read instanceof Uint8Array) delivered.push(...read)
          offset += chunk.length
        }
        expect(Uint8Array.from(delivered)).toEqual(payload)
        expect(unwrap.header).toEqual(header)
        expect(forServer(true, unwrap.header, payload)).toEqual(stream)
        expect(forServer(false, unwrap.header, payload)).toEqual(payload)
      },
    ),
    properties,
  )
})

test('every proper header prefix waits, including a split immediately before its last byte', () => {
  const header = proxyHeader({ address: '2001:db8::1', port: 51234 }, { address: '2001:db8::2', port: 25565 })
  for (let split = 0; split < header.length; split++) {
    const unwrap = new Unwrap()
    expect(unwrap.take(header.subarray(0, split))).toBeNull()
    expect(unwrap.header).toBeNull()
    expect(unwrap.take(header.subarray(split))).toEqual(new Uint8Array())
    expect(unwrap.header).toEqual(header)
  }
})

test('a LOCAL connection loses only the header and keeps header-like bytes in its payload', () => {
  const unwrap = new Unwrap()
  const payload = Uint8Array.from([...LOCAL_HEADER, 1, 2, 3])
  expect(unwrap.take(LOCAL_HEADER)).toEqual(new Uint8Array())
  expect(unwrap.take(payload)).toEqual(payload)
  expect(forServer(true, null, payload)).toEqual(Uint8Array.from([...LOCAL_HEADER, ...payload]))
})
