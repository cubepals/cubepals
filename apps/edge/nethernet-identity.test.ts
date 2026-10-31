// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto'
import { nethernetIdentity } from './nethernet-identity.ts'

const KEY = Buffer.alloc(16, 7)

test('the same Floodgate key gives every edge the same identity, and another key another', () => {
  expect(nethernetIdentity(KEY)).toBe(nethernetIdentity(Buffer.from(KEY)))
  expect(nethernetIdentity(Buffer.alloc(16, 8))).not.toBe(nethernetIdentity(KEY))
})

test('it is a P-384 private key as PKCS#8 PEM, which signs and verifies', () => {
  const pem = nethernetIdentity(KEY)
  expect(pem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
  const key = createPrivateKey(pem)
  expect(key.asymmetricKeyDetails?.namedCurve).toBe('secp384r1')
  const signature = createSign('sha384').update('signaling').sign(key)
  expect(createVerify('sha384').update('signaling').verify(createPublicKey(key), signature)).toBe(true)
})
