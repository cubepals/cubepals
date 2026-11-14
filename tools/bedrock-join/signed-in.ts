// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Bedrock player that a real Xbox account signs in, for the join that proves a signed-in player
 * gets in with the edge's Xbox sign-in check on. One provider holds the account's sign-in and the
 * player's one key: Minecraft's services issue the login's chain and the multiplayer token for
 * that key, and the NetherNet offer is signed with the same key and carries the same token, as the
 * game does. Geyser refuses a login whose key isn't the one its connection was admitted with, so
 * nothing here ever makes a second key.
 *
 * The sign-in lives in a cache directory (prismarine-auth's files), signed in once by a person with
 * `xbox-sign-in.ts` and renewed by prismarine-auth on each use. Where nobody is signed in, a CI run
 * doesn't wait for a person to enter a code: it says the account must be signed in again and exits
 * with {@link REAUTH_EXIT}.
 *
 * Not for the offline players the rest of the Bedrock check uses (`join.ts` without `--xbox`).
 */

import { createPublicKey } from 'node:crypto'
import { type DeviceCode, XboxAuthProvider, type XboxTokenSource } from '@jsprismarine/auth'
import { netherNetIdentityOf } from '@jsprismarine/client/net/netherNetIdentityOf'
import type { NetherNetIdentity } from '@jsprismarine/nethernet'
import { REAUTH_EXIT, SIGN_IN_COMMAND } from './exits.ts'

/** The name the sign-in is cached under. */
export const DEFAULT_ACCOUNT = 'cubepals-bedrock-check'

/**
 * prismarine-auth logs requests and tokens through the `debug` module when DEBUG names it. It is
 * read when that module loads, which is the first sign-in, so it is taken out of this process
 * before then. Its other output (a failed refresh's warning, Microsoft's error text) carries no
 * token.
 */
export function quietTokens(env: Record<string, string | undefined> = process.env): void {
  delete env.DEBUG
  delete env.DEBUG_COLORS
}

/**
 * What a CI run does when prismarine-auth would ask a person for a device code: one line naming the
 * command that fixes it, never the code or where to enter it, then the reauth exit.
 */
export function reauthInstead(
  exit: (code: number) => never = process.exit,
  say: (line: string) => void = (line) => console.error(line),
): () => never {
  return () => {
    say(`The Bedrock test account's Xbox sign-in is missing or no longer valid: run ${SIGN_IN_COMMAND}.`)
    return exit(REAUTH_EXIT)
  }
}

export interface SignedInOptions {
  /** prismarine-auth's cache directory, holding the account's sign-in. */
  cacheDirectory: string
  account?: string
  /** Where tokens come from; prismarine-auth by default. A test gives its own. */
  tokens?: XboxTokenSource
  /** Called when nobody is signed in; a CI run's default says so and exits ({@link reauthInstead}). */
  onDeviceCode?: (code: DeviceCode) => void
}

/** The account's provider: its sign-in, and the one key the player logs in and signs offers with. */
export function signedInProvider(options: SignedInOptions): XboxAuthProvider {
  quietTokens()
  return new XboxAuthProvider({
    cacheDirectory: options.cacheDirectory,
    account: options.account ?? DEFAULT_ACCOUNT,
    onDeviceCode: options.onDeviceCode ?? reauthInstead(),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
  })
}

/**
 * The identity the NetherNet offer is signed with: the provider's own key, carrying the
 * multiplayer token Minecraft's services issued for it. The client's own function, so the offer is
 * made exactly as a client that dials directly makes it.
 */
export async function signedInIdentity(auth: XboxAuthProvider): Promise<NetherNetIdentity> {
  const token = await auth.getMultiplayerToken()
  if (tokenKey(token) !== (await auth.getIdentityPublicKey()))
    throw new Error("the multiplayer token names another key than the player's, which Geyser refuses")
  const identity = await netherNetIdentityOf(auth)
  if (identity === undefined)
    throw new Error('the Xbox sign-in gave no multiplayer token to sign the offer with')
  return identity
}

/**
 * The key a multiplayer token's `cpk` claim names, as base64 DER (the form IdentityKey keeps), or
 * null where it names none. Its claims are read, not verified: Minecraft's services signed it, and
 * the edge verifies it.
 */
export function tokenKey(token: string): string | null {
  const [, payload = ''] = token.split('.')
  let cpk: unknown
  try {
    cpk = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { cpk?: unknown }).cpk
  } catch {
    return null
  }
  const key =
    typeof cpk === 'string'
      ? createPublicKey({ key: Buffer.from(cpk, 'base64'), format: 'der', type: 'spki' })
      : typeof cpk === 'object' && cpk !== null
        ? createPublicKey({ key: cpk as JsonWebKey, format: 'jwk' })
        : null
  return key === null ? null : key.export({ type: 'spki', format: 'der' }).toString('base64')
}
