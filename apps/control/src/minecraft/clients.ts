// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which players' games a server takes: the protocol numbers of the clients that can join it, from
 * the release it runs and the plugins that translate for other releases. A client speaks one
 * protocol number, which several releases can share (1.21.9 and 1.21.10 are both 773), so the
 * range is of numbers, and its ends are named by the releases players know.
 *
 * The numbers are minecraft-data's (`protocol-versions.json`, kept by `scripts/protocols.ts`).
 * Not for deciding which plugins a server gets (`app/setups/service.ts`), or for what a player is
 * told when their game is outside the range (apps/edge).
 */
import type { PinnedMod } from '../domain/mods/artifact.ts'
import type { Loader } from '../domain/revision/revision.ts'
import { runsPlugin, VIABACKWARDS, VIAREWIND, VIAVERSION } from './mods.ts'
import published from './protocol-versions.json' with { type: 'json' }

/** Every release since 1.7.2, newest first, with the protocol number its client speaks. */
export const RELEASES: ReadonlyArray<{ name: string; protocol: number }> = published.releases

/**
 * The oldest releases whose clients ViaBackwards and ViaRewind let in, as their own pages say:
 * ViaBackwards back to 1.9, and ViaRewind, beside it, to 1.8 and 1.7.
 */
const VIABACKWARDS_OLDEST = '1.9'
const VIAREWIND_OLDEST = '1.7.2'

/** The clients a server takes. */
export interface ClientRange {
  /** The release the server runs, and its protocol number. */
  release: string
  protocol: number
  /** The oldest protocol number it takes, and the release players know it by. */
  oldest: number
  oldestRelease: string
  /** The newest it takes; null when every newer one joins too, as with ViaVersion. */
  newest: number | null
}

/** The protocol number of `release`'s clients; null for one the table doesn't know. */
export const protocolOf = (release: string): number | null =>
  RELEASES.find((known) => known.name === release)?.protocol ?? null

/**
 * The clients a server on `gameVersion` with `mods` takes. Only Paper runs the Via plugins; on any
 * other server type a client must speak the server's own number. Null for a release the table
 * doesn't know, which takes whatever it takes.
 */
export function clientRange(
  gameVersion: string,
  loader: Loader,
  mods: readonly PinnedMod[],
): ClientRange | null {
  const protocol = protocolOf(gameVersion)
  if (protocol === null) return null
  const own: ClientRange = {
    release: gameVersion,
    protocol,
    oldest: protocol,
    oldestRelease: gameVersion,
    newest: protocol,
  }
  // ViaBackwards and ViaRewind are ViaVersion's addons, and load only beside it.
  if (loader !== 'paper' || !runsPlugin(mods, VIAVERSION)) return own
  const floor = runsPlugin(mods, VIABACKWARDS)
    ? runsPlugin(mods, VIAREWIND)
      ? VIAREWIND_OLDEST
      : VIABACKWARDS_OLDEST
    : gameVersion
  const oldest = Math.min(protocol, protocolOf(floor) ?? protocol)
  return { ...own, oldest, oldestRelease: oldest === protocol ? gameVersion : floor, newest: null }
}
