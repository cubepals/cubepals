// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The secret half of a server's invite link. Whoever holds it may open the server's page and,
 * while the whitelist is on, put themselves on it, so it is drawn from the system's random
 * source rather than Math.random, and a reset issues a new one.
 *
 * `nanoid`'s custom alphabet does exactly this, and it was tried here on 2026-09-23. It stays
 * written out because of where this lives: `app/` may depend on nothing but the database, the
 * contracts and Node itself (`scripts/check-boundaries.ts`), so using it would mean a port, an
 * adapter, a fake and the wiring for all three — more machinery than the eight lines of
 * arithmetic it would hide, for a generator that is covered by its own test.
 */

/** No 0/O or 1/l: a code is read aloud and typed by hand as often as it is clicked. */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'
const LENGTH = 12
/** Bytes at or above this would favour the alphabet's first characters, so they are drawn again. */
const CEILING = 256 - (256 % ALPHABET.length)

export function newInviteCode(): string {
  let code = ''
  while (code.length < LENGTH) {
    const bytes = new Uint8Array(LENGTH * 2)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (code.length === LENGTH) break
      if (byte >= CEILING) continue
      code += ALPHABET[byte % ALPHABET.length]
    }
  }
  return code
}

/** What an invite link's code may look like, before anything is looked up. */
export const looksLikeInviteCode = (code: string): boolean =>
  code.length === LENGTH && [...code].every((ch) => ALPHABET.includes(ch))
