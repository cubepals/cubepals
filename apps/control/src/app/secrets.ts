// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

/**
 * Per-server secrets are derived, never stored: HMAC of the deployment's key over the server id
 * and a purpose. Rotating the key rotates every server on its next apply.
 */
export type SecretPurpose = 'rcon' | 'artifacts'

/**
 * The deployment's runtime keys: rotation is a key-version bump plus an apply (docs/configuration.md,
 * "Rotating the runtime key"). The current
 * key derives every new secret and seals; earlier ones are still accepted while servers move off
 * them, and are dropped once none runs on them.
 */
export interface SecretKeyring {
  readonly current: { readonly version: number; readonly key: string }
  readonly previous: readonly { readonly version: number; readonly key: string }[]
}

/** A deployment with one key: nothing is being rotated. */
export const singleKey = (key: string): SecretKeyring => ({ current: { version: 1, key }, previous: [] })

/** Every key still accepted, the current one first. */
const acceptedKeys = (ring: SecretKeyring): readonly string[] => [
  ring.current.key,
  ...ring.previous.map((k) => k.key),
]

/** A server's secret under every key still accepted, the current one first. */
export const acceptedSecrets = (ring: SecretKeyring, serverId: string, purpose: SecretPurpose): string[] =>
  acceptedKeys(ring).map((key) => deriveServerSecret(key, serverId, purpose))

/**
 * One secret per server and purpose, from the deployment's key. HMAC-SHA-256 over a label is
 * HKDF's expand step with a single block, which is why it is safe to use this way.
 *
 * Node's own `crypto.hkdf` is the primitive meant for this and would be a fair swap — weighed
 * on 2026-09-23 and left alone, because changing the construction changes every secret every
 * running server already holds: its RCON password and its artifact token would both rotate
 * under it, for no difference anybody could observe.
 */
export function deriveServerSecret(key: string, serverId: string, purpose: SecretPurpose): string {
  return createHmac('sha256', key).update(`${purpose}:${serverId}`).digest('base64url').slice(0, 32)
}

/**
 * Something the deployment must keep but never leave readable at rest, such as a TLS private
 * key in the database: AES-256-GCM under a key derived from the deployment's key and a purpose.
 */
export function sealSecret(key: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealingKey(key, purpose), iv)
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    sealed.toString('base64url'),
  ].join('.')
}

/** The plaintext under the first accepted key that opens it; null when none does. */
export function openSealed(ring: SecretKeyring, purpose: string, sealed: string): string | null {
  for (const key of acceptedKeys(ring)) {
    const opened = openSecret(key, purpose, sealed)
    if (opened !== null) return opened
  }
  return null
}

/** The plaintext, or null when it was sealed under another key or purpose, or tampered with. */
export function openSecret(key: string, purpose: string, sealed: string): string | null {
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || !body) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(key, purpose), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

const sealingKey = (key: string, purpose: string) =>
  createHmac('sha256', key).update(`seal:${purpose}`).digest()
