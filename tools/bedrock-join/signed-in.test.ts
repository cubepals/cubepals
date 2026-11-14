// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * That a signed-in Bedrock player offers and logs in as one player: the NetherNet offer carries
 * the multiplayer token Minecraft's services issued for the provider's key and is signed by that
 * key, and the login's own chain link names the same key and carries the same token. A token for
 * another key, which Geyser refuses, is caught before any offer. No network: the tokens come from a
 * stand-in for Minecraft's services, signed by keys made here.
 */

import { expect, test } from 'bun:test'
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { IdentityKey, type XboxTokenSource } from '@jsprismarine/auth'
import {
  canonicalFingerprints,
  compactEs384,
  sdpFingerprints,
  verifiesDetachedEs384,
} from '@jsprismarine/nethernet'
import { REAUTH_EXIT } from './exits.ts'
import { quietTokens, reauthInstead, signedInIdentity, signedInProvider, tokenKey } from './signed-in.ts'

const ACCOUNT = {
  XUID: '2535412345678901',
  identity: '6f1d2c3b-0000-4000-8000-000000000001',
  displayName: 'CheckPlayer',
}
/** Minecraft's services, in this test: a key of its own that signs what it issues. */
const services = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey
const der = (key: KeyObject) => key.export({ type: 'spki', format: 'der' }).toString('base64')
const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>
const headerOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[0] ?? '', 'base64url').toString()) as Record<string, unknown>

/** What the services issue for a key: a chain naming the account, and a multiplayer token for `cpkOf(key)`. */
function standIn(
  cpkOf: (key: KeyObject) => KeyObject = (key) => key,
): XboxTokenSource & { tokens: string[] } {
  const tokens: string[] = []
  return {
    tokens,
    async getMinecraftBedrockToken(publicKey) {
      const exp = Math.floor(Date.now() / 1000) + 3600
      const token = await compactEs384(
        { x5u: der(createPublicKey(services)) },
        { cpk: der(cpkOf(publicKey)), exp },
        services,
      )
      tokens.push(token)
      const link = await compactEs384(
        { x5u: der(createPublicKey(services)) },
        { extraData: ACCOUNT, exp },
        services,
      )
      return { chain: [link], token }
    },
  }
}

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  `a=fingerprint:sha-256 ${'AB:'.repeat(31)}AB`,
  '',
].join('\r\n')

test('the offer carries the multiplayer token for the player’s key, and is signed by that key', async () => {
  const key = IdentityKey.generate()
  const tokens = standIn()
  const auth = signedInProvider({ cacheDirectory: '/nonexistent', tokens })
  // The provider's key is its own; this test reads it to compare, as Geyser compares.
  const providerKey = await auth.getIdentityPublicKey()
  const offer = await (await signedInIdentity(auth)).sign(SDP)
  const line = offer.split('\r\n').find((l) => l.startsWith('a=identity:')) ?? ''
  const identity = JSON.parse(Buffer.from(line.slice('a=identity:'.length), 'base64').toString()) as {
    assertion: string
  }
  const assertion = JSON.parse(identity.assertion) as { token: string; fingerprints: string }
  expect(assertion.token).toBe(tokens.tokens[0] ?? 'no token')
  expect(claimsOf(assertion.token).cpk).toBe(providerKey)
  const named = createPublicKey({ key: Buffer.from(providerKey, 'base64'), format: 'der', type: 'spki' })
  expect(
    await verifiesDetachedEs384(assertion.fingerprints, canonicalFingerprints(sdpFingerprints(SDP)), named),
  ).toBe(true)
  // Not merely some key: a stranger's doesn't verify it.
  expect(
    await verifiesDetachedEs384(
      assertion.fingerprints,
      canonicalFingerprints(sdpFingerprints(SDP)),
      key.publicKey,
    ),
  ).toBe(false)
})

test('the login names the same key and carries the same token as the offer', async () => {
  const tokens = standIn()
  const auth = signedInProvider({ cacheDirectory: '/nonexistent', tokens })
  await signedInIdentity(auth)
  const login = await auth.createLoginCredentials({
    serverAddress: 'check.play.example:19132',
    protocolVersion: 2225,
  })
  const chainData = JSON.parse(login.chainData) as { Certificate: string; Token: string }
  const { chain } = JSON.parse(chainData.Certificate) as { chain: string[] }
  const own = chain[0] ?? ''
  const providerKey = await auth.getIdentityPublicKey()
  expect(headerOf(own).x5u).toBe(providerKey)
  expect(chainData.Token).toBe(tokens.tokens[0] ?? 'no token')
  // One sign-in for both: the offer and the login didn't each fetch a token.
  expect(tokens.tokens).toHaveLength(1)
  expect(chain.slice(1)).toHaveLength(1)
  expect((await auth.getIdentity()).displayName).toBe(ACCOUNT.displayName)
  expect((await auth.getIdentity()).xuid).toBe(ACCOUNT.XUID)
})

test('a multiplayer token for another key is refused before any offer is made', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
  const auth = signedInProvider({ cacheDirectory: '/nonexistent', tokens: standIn(() => other) })
  await expect(signedInIdentity(auth)).rejects.toThrow('another key')
  expect(tokenKey('not-a-token')).toBeNull()
})

test('with nobody signed in, a CI run says how to fix it and exits with the reauth code, naming no code', () => {
  const said: string[] = []
  const exits: number[] = []
  const onDeviceCode = reauthInstead(
    (code) => {
      exits.push(code)
      throw new Error('exited')
    },
    (line) => said.push(line),
  )
  expect(() => onDeviceCode()).toThrow('exited')
  expect(exits).toEqual([REAUTH_EXIT])
  expect(said).toHaveLength(1)
  expect(said[0]).toContain('bun scripts/bedrock-xbox-sign-in.ts')
  expect(said[0]).not.toMatch(/microsoft\.com|code [A-Z0-9]{6,}/i)
})

test('prismarine-auth’s debug output, which prints tokens, is switched off', () => {
  const env: Record<string, string | undefined> = {
    DEBUG: 'prismarine-auth',
    DEBUG_COLORS: '1',
    HOME: '/home',
  }
  quietTokens(env)
  expect(env).toEqual({ HOME: '/home' })
})
