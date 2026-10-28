// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The networks a server's own players join it from, so a server-list ping from one of them may
 * wake the server before the join (`ping-wake.ts`), and a ping from anywhere else may not; and a
 * join from one under a player's name isn't held to the hour's wakes (`service.ts`). A
 * network counts once a join from it ends that the server itself saw the player on, and for
 * `AbuseLimits.knownAddressDays` after the last such join; then it is forgotten.
 *
 * Only a hash of the network is kept (`known_addresses`), under a key derived for the server from
 * the deployment's runtime key: it says nothing of who joined, can't be read back without that
 * key, and the same network is a different hash on every server. Rotating the runtime key forgets
 * them all, which costs only an early wake or two.
 *
 * Not for who may join a running server: an address only chooses whether a server warms up early,
 * and which wakes the hour counts.
 */
import { createHmac } from 'node:crypto'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { type Queryable, schema } from '@blockly/db'
import { and, eq, gt, lt, or, sql } from 'drizzle-orm'
import { addressKey } from '../../domain/account/free-play.ts'
import { deriveServerSecret, type SecretKeyring } from '../secrets.ts'
import { tuning } from '../tuning.ts'

const known = schema.knownAddresses
const played = schema.serverPlayers

/**
 * How recently the server itself must have seen a player when their join ends for it to count: it
 * reads who is on every minute, so a player who was on has a reading this close to their leaving.
 */
const SEEN_WITHIN_MS = 5 * MINUTE_MS

/**
 * What `address` is kept as for `serverId`: its network's hash, an IPv6 address by its /64, so a
 * phone or home whose IPv6 address changes every day still counts. Null for no address. A join's
 * record keeps its network the same way (`app/joins/`).
 */
export function addressHash(
  ring: SecretKeyring,
  serverId: string,
  address: string | undefined,
): string | null {
  const network = addressKey(address)
  if (network === null) return null
  const key = deriveServerSecret(ring.current.key, serverId, 'addresses')
  return createHmac('sha256', key).update(network).digest('base64url')
}

/**
 * A join from `address` ended at `at`. Its network is known from then on where the server itself
 * saw the player on moments before; the player is only what their game claimed, so a client the
 * server turned away (no account, not on the whitelist) leaves nothing behind. Whether it was kept.
 */
export async function joinEnded(
  q: Queryable,
  ring: SecretKeyring,
  serverId: string,
  address: string | undefined,
  player: { uuid: string; name: string },
  at: Date,
): Promise<boolean> {
  const hash = addressHash(ring, serverId, address)
  if (hash === null) return false
  // By name too: an offline-mode server gives a player another ID than the one their game claims.
  const [seen] = await q
    .select({ uuid: played.playerUuid })
    .from(played)
    .where(
      and(
        eq(played.serverId, serverId),
        or(eq(played.playerUuid, player.uuid), sql`lower(${played.playerName}) = lower(${player.name})`),
        gt(played.confirmedAt, new Date(at.getTime() - SEEN_WITHIN_MS)),
      ),
    )
    .limit(1)
  if (seen === undefined) return false
  await q
    .insert(known)
    .values({ serverId, address: hash, seenAt: at })
    .onConflictDoUpdate({
      target: [known.serverId, known.address],
      set: { seenAt: sql`greatest(${known.seenAt}, excluded.seen_at)` },
    })
  return true
}

/** The earliest end of a join that still counts at `now`. */
const countsSince = (now: Date): Date => new Date(now.getTime() - tuning().abuse.knownAddressDays * DAY_MS)

/** Whether a join of the server's own players from `address`'s network ended recently enough to count. */
export async function knownAddress(
  q: Queryable,
  ring: SecretKeyring,
  serverId: string,
  address: string | undefined,
  now: Date,
): Promise<boolean> {
  const hash = addressHash(ring, serverId, address)
  if (hash === null) return false
  const [row] = await q
    .select({ seenAt: known.seenAt })
    .from(known)
    .where(and(eq(known.serverId, serverId), eq(known.address, hash), gt(known.seenAt, countsSince(now))))
  return row !== undefined
}

/** `known-addresses`: forgets every network that no longer counts. How many were forgotten. */
export async function forgetAddresses(q: Queryable, now: Date): Promise<number> {
  const gone = await q
    .delete(known)
    .where(lt(known.seenAt, countsSince(now)))
    .returning({ serverId: known.serverId })
  return gone.length
}
