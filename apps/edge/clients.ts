// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a player's game can join a server, by the protocol number its client names in the
 * handshake and the range the server's route gives (`joins`, worked out by the control plane), and
 * what a player whose game can't is told. The edge says so at once, before anything is woken: the
 * server would only refuse them once it was up.
 *
 * Not for working the range out, which the control plane does from the server's release and its
 * plugins (apps/control/src/minecraft/clients.ts).
 */
import type { EdgeRoute, EdgeRoutes } from '@blockly/contracts/edge'

export type Joins = NonNullable<EdgeRoute['joins']>
type Releases = NonNullable<EdgeRoutes['releases']>

/** Whether a client speaking `protocol` can join a server that takes `joins`; any can where it says nothing. */
export const takes = (joins: Joins | undefined, protocol: number): boolean =>
  joins === undefined ||
  (protocol >= joins.oldest && (joins.newest === undefined || protocol <= joins.newest))

/**
 * What a join from a game the server can't take is told: the Minecraft the server runs, the
 * player's own, as the newest release that speaks its number, and what to do.
 */
export function wrongGame(joins: Joins, protocol: number, releases: Releases): string {
  const theirs = releases.find((release) => release.protocol === protocol)?.name
  const game = theirs === undefined ? 'another version' : theirs
  return `This server runs Minecraft ${joins.release}. Your game is ${game}: switch to ${joins.release} in the launcher, then join.`
}
