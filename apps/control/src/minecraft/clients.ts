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
 * Not for deciding which plugins a server gets (`app/compat/`), or for what a player is
 * told when their game is outside the range (apps/edge).
 */
import type { PinnedMod } from '../domain/mods/artifact.ts'
import {
  type Loader,
  type OtherVersions,
  otherVersionsOf,
  type ServerRevision,
  type ServerSettings,
} from '../domain/revision/revision.ts'
import { COMPAT, runsPlugin, VIABACKWARDS, VIAREWIND, VIAVERSION } from './mods.ts'
import published from './protocol-versions.json' with { type: 'json' }

/** Every release since 1.7.2, newest first, with the protocol number its client speaks. */
export const RELEASES: ReadonlyArray<{ name: string; protocol: number }> = published.releases

/**
 * The oldest releases whose clients ViaBackwards and ViaRewind let in, as the jars Cubepals pins
 * prove: the oldest protocol package in ViaBackwards 5.12.1 is
 * `com/viaversion/viabackwards/protocol/v1_9_1to1_9` (the 1.9 client, protocol 107), and in ViaRewind
 * 4.2.0 `com/viaversion/viarewind/protocol/v1_7_6_10to1_7_2_5` (1.7.2 to 1.7.5, protocol 4). A newer
 * jar that reaches further back is a reason to change these.
 */
export const VIABACKWARDS_OLDEST = '1.9'
export const VIAREWIND_OLDEST = '1.7.2'

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
 * The clients a server on `gameVersion` with `mods` takes, with the Via plugins Cubepals adds,
 * `adds` by Modrinth project id, counted as its own. Only Paper runs them; on any other server type
 * a client must speak the server's own number. Null for a release the table doesn't know, which
 * takes whatever it takes.
 */
export function clientRange(
  gameVersion: string,
  loader: Loader,
  mods: readonly PinnedMod[],
  adds: readonly string[] = [],
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
  const runs = (projectId: string) => runsPlugin(mods, projectId) || adds.includes(projectId)
  // ViaBackwards and ViaRewind are ViaVersion's addons, and load only beside it.
  if (loader !== 'paper' || !runs(VIAVERSION)) return own
  const floor = runs(VIABACKWARDS) ? (runs(VIAREWIND) ? VIAREWIND_OLDEST : VIABACKWARDS_OLDEST) : gameVersion
  const oldest = Math.min(protocol, protocolOf(floor) ?? protocol)
  return { ...own, oldest, oldestRelease: oldest === protocol ? gameVersion : floor, newest: null }
}

/**
 * Which players' games a revision's server takes, as its pages say it: from `oldest` to the release
 * it runs, and every newer one where `newer`, with the choice behind it on a server that has one
 * (Paper, playing no pack). With `adds`, the Via plugins Cubepals places for it, as a boot placed
 * them or the next will; without, those its choice asks for. Null for a release the table doesn't
 * know.
 */
export function joinsOf(
  revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'mods' | 'modpack'> & {
    settings: Pick<ServerSettings, 'otherVersions'>
  },
  adds?: readonly string[],
): { oldest: string; newer: boolean; otherVersions: OtherVersions | null } | null {
  const chooses = revision.loader === 'paper' && revision.modpack === null
  const otherVersions = chooses ? otherVersionsOf(revision.settings) : null
  const placed = otherVersions === null ? [] : (adds ?? COMPAT[otherVersions])
  const range = clientRange(revision.gameVersion, revision.loader, revision.mods, placed)
  return range === null ? null : { oldest: range.oldestRelease, newer: range.newest === null, otherVersions }
}

/** Which players' games a revision's server takes, as pages word them; its own release alone for one the table doesn't know. */
export const joinRange = (revision: Parameters<typeof joinsOf>[0]): { oldest: string; newer: boolean } => {
  const joins = joinsOf(revision)
  return { oldest: joins?.oldest ?? revision.gameVersion, newer: joins?.newer ?? false }
}
