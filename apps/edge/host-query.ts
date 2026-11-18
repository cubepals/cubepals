// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Takes Minecraft 26.4's query properties out of a Java handshake's hostname. From 26.4 a client
 * writes `host?key=value&…` there (`ServerConnectionDetails.hostForIntentPacket`): `_o`, the address
 * the player typed, when it followed an SRV record to `host`; `_id`, from an address typed
 * `id@host`; and whatever else was typed after a `?`. Keys and values are URL-encoded.
 *
 * The front door passes on the hostname without them (`front.ts`), so mc-router, the sleeping
 * notice, the waiting room and the server itself all see the address as a client before 26.4 sent
 * it. mc-router 1.49.0 routes no hostname that carries them, and a later mc-router routes on `_o`,
 * the player's own name for the server, which only the target names here. The server is the only
 * other reader: it checks `_id` against `allowed-connection-ids`, which Cubepals never sets, and
 * which the game leaves empty to take any.
 *
 * Not for forwarding, which is what follows a NUL (`forwarding.ts`).
 */

import { QUERY_START, withHostname } from './notice.ts'

/** The keys `query` names, decoded as the game decodes them; a key that doesn't decode, as it is. */
export function queryKeys(query: string): string[] {
  return query
    .split('&')
    .filter((property) => property !== '')
    .map((property) => {
      const key = property.split('=')[0] ?? ''
      try {
        return decodeURIComponent(key.replaceAll('+', ' '))
      } catch {
        return key
      }
    })
}

/**
 * `bytes` with the query cut from the handshake's hostname, and the keys it carried (none when it
 * carried no query). What follows a NUL stays, as `withoutForwarding` judges it.
 */
export function withoutQuery(bytes: Uint8Array): { bytes: Uint8Array; keys: string[] } {
  let keys: string[] = []
  const out = withHostname(bytes, (host) => {
    const nul = host.indexOf('\0')
    const name = nul === -1 ? host : host.slice(0, nul)
    const start = name.indexOf(QUERY_START)
    if (start === -1) return null
    keys = queryKeys(name.slice(start + 1))
    return name.slice(0, start) + (nul === -1 ? '' : host.slice(nul))
  })
  return { bytes: out, keys }
}
