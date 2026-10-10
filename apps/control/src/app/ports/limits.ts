// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Counting what the surfaces nobody signs in to may do (§15.6): a public page, an invite link,
 * the status endpoint, the badge. Everything an account does is bounded by `AccessPolicy`; this
 * is for the reads where there is no account to bound.
 *
 * Keys are what is being protected — a server, an invite code, or a whole surface — never a
 * person: whoever is asking can change their address, but not which server they ask about.
 */
export interface Limits {
  /** Whether this one is within the limit for its window, counting it when it is. */
  allow(key: string, limit: number): Promise<boolean>
}
