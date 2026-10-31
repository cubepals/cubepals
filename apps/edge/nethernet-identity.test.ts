// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto'
import { nethernetIdentity } from './nethernet-identity.ts'

const TOKEN = 'an edge token'

test('the same edge token gives every edge the same identity, and another token another', () => {
  expect(nethernetIdentity(TOKEN)).toBe(nethernetIdentity(`${TOKEN}`))
  expect(nethernetIdentity('another edge token')).not.toBe(nethernetIdentity(TOKEN))
})

test('there is no identity without a token', () => {
  expect(() => nethernetIdentity('')).toThrow('EDGE_TOKEN')
})

test('it is a P-384 private key as PKCS#8 PEM, which signs and verifies', () => {
  const pem = nethernetIdentity(TOKEN)
  expect(pem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
  const key = createPrivateKey(pem)
  expect(key.asymmetricKeyDetails?.namedCurve).toBe('secp384r1')
  const signature = createSign('sha384').update('signaling').sign(key)
  expect(createVerify('sha384').update('signaling').verify(createPublicKey(key), signature)).toBe(true)
})
