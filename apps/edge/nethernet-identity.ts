// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The identity Geyser's NetherNet signaling signs with: a P-384 key whose public half Bedrock
 * clients pin, so a different key makes every returning player confirm the server again. Geyser
 * would make one on its first start, in a folder that goes with the machine; every edge, in every
 * region and after every deploy, must present the same one. So it is derived here from the
 * Floodgate key every edge already holds, and written where Geyser looks for it. Not for anything
 * else the key is used for: what it derives is bound to this use alone.
 */

import { createECDH, createPrivateKey, hkdfSync } from 'node:crypto'

/** P-384's group order, from SEC 2 (secp384r1, section 2.5.1): a private key is in [1, n - 1]. */
const P384_ORDER = BigInt(
  '0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973',
)
/** A P-384 scalar and each coordinate are 48 bytes. */
const P384_BYTES = 48
/** Binds what is derived to this one use, so the same key yields nothing usable elsewhere. */
const INFO = 'cubepals edge nethernet identity v1'

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

/** The identity's private key as PKCS#8 PEM, the same for the same Floodgate key. */
export function nethernetIdentity(floodgateKey: Uint8Array): string {
  // 64 bytes taken modulo n - 1 leave no bias that matters, and the + 1 keeps the scalar off zero.
  const wide = Buffer.from(hkdfSync('sha384', floodgateKey, Buffer.alloc(0), INFO, 64))
  const scalar = (BigInt(`0x${wide.toString('hex')}`) % (P384_ORDER - 1n)) + 1n
  const d = Buffer.from(scalar.toString(16).padStart(P384_BYTES * 2, '0'), 'hex')
  const ecdh = createECDH('secp384r1')
  ecdh.setPrivateKey(d)
  // Uncompressed: 0x04, then x and y.
  const point = ecdh.getPublicKey()
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-384',
      d: base64url(d),
      x: base64url(point.subarray(1, 1 + P384_BYTES)),
      y: base64url(point.subarray(1 + P384_BYTES)),
    },
  })
  return key.export({ type: 'pkcs8', format: 'pem' }).toString()
}
