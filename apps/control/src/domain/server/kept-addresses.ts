// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Addresses Cubepals keeps for one of its own servers, beside that server's own address: a join
 * or a browser at a kept address reaches the server it points at, as at that server's address.
 * A kept address is not a server, so the server's page, stats and players stay its own. Nobody
 * gives a server a kept address (`held-names.ts`); read when an address is chosen and when one
 * is routed (`config/play-addressing.ts`, `app/edge/service.ts`).
 */

/** Each kept address, and the slug of the server it points at. */
const KEPT: ReadonlyMap<string, string> = new Map([
  // Shown in Cubepals' own published images as an address to join.
  ['sunset-valley', 'arcade'],
])

/** The slug of the server a kept address points at; null for any other address. */
export function keptFor(address: string): string | null {
  return KEPT.get(address) ?? null
}

/** The kept addresses that point at the server at `slug`. */
export function keptAt(slug: string): readonly string[] {
  return [...KEPT].flatMap(([address, target]) => (target === slug ? [address] : []))
}
