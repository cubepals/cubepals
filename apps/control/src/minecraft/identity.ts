// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who a player is to a server (§15.1). A server that verifies accounts knows a player by the
 * UUID of their Minecraft account. One that doesn't derives a UUID from the name the player
 * typed, capitals included: Java's `UUID.nameUUIDFromBytes` over `OfflinePlayer:<name>`, a
 * version 3 UUID of its MD5. The same person is two different players to the two kinds of
 * server, which is why everything keyed by a player moves when a server changes kind.
 *
 * The digest is the caller's: `minecraft/` stays free of packages, Node's crypto included.
 */

/** The bytes a server that doesn't verify accounts hashes to name a player. */
export const offlineIdentitySeed = (name: string): string => `OfflinePlayer:${name}`

/** A version 3 UUID from an MD5 digest, the way `UUID.nameUUIDFromBytes` makes one. */
export function uuidFromMd5(digest: Uint8Array): string {
  if (digest.length !== 16) throw new Error('An MD5 digest is 16 bytes')
  const bytes = Uint8Array.from(digest)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x30
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Whether a UUID is a Minecraft account's: Mojang issues version 4 UUIDs, and a server that
 * doesn't verify accounts makes version 3 ones from names, which no account has.
 */
export function isAccountUuid(uuid: string): boolean {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(hex) && hex[12] === '4'
}
