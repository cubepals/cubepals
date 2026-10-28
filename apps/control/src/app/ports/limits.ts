// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Counting what the surfaces nobody signs in to may do (§15.6): a public page, an invite link,
 * the status endpoint, the badge. Everything an account does is bounded by `AccessPolicy`; this
 * is for the reads where there is no account to bound, for the consoles an account opens over
 * realtime, which never reach a procedure, and for an account's reads of a provider that leave
 * nothing in the audit log to count them by (`BillingService.refresh`).
 *
 * Keys are what is being protected — a server, an invite code, or a whole surface — or the
 * signed-in account acting, never an address alone: whoever is asking can change their address,
 * but not which server they ask about, nor which account they are signed in to.
 */
export interface Limits {
  /** Whether this one is within the limit for its window, counting it when it is. */
  allow(key: string, limit: number): Promise<boolean>
}
