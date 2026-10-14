// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether there is room for a new server, the one rule every create is admitted by
 * (`policy.ts`), and whether room is tight. Pure, over counts the application gathers
 * (`app/platform/room.ts`).
 *
 * Room is the smallest of what holds servers back: the platform's caps, the runtimes' own
 * ceilings, whether a runtime could take one now, and how long creates already wait for a worker.
 * New servers leave a reserve of it to the servers people already have, so a start or a wake is
 * never refused because creates filled the room. Free plans fill only a share of what is left;
 * paid plans create in all of it.
 */

/** What room there is, as counted now. */
export interface RoomFacts {
  controls: { maxServers: number; maxRunningServers: number }
  /** The most servers the runtimes can hold at their busiest; null when nothing limits them. */
  serverCeiling: number | null
  /** Servers holding compute, and how many of them are running or on their way. */
  global: { servers: number; running: number }
  /** Whether a runtime new servers go to could take one now. */
  runtimes: boolean
  /** How long the oldest create still waiting for a worker has waited, in milliseconds. */
  queuedCreateMs: number
}

export interface RoomRules {
  /** Servers and running places creates leave to the servers people already have. */
  wakeReserve: number
  /** How long the oldest waiting create may have waited before creates count as full. */
  createWaitMs: number
  /** The share of the room for new servers that free plans may fill. */
  freeShare: number
}

/**
 * Where a deployment sets neither WAKE_RESERVE nor CREATE_WAIT_SECONDS. Two places stay for
 * starts and wakes: one for a wake already on its way and one for the next, whatever the size of
 * the deployment, while a larger share would close creates on a small one long before anyone
 * waits. A minute is past the moment a worker picks up a create when it has a free hand, and
 * well short of the many minutes a person would otherwise wait to learn there's no room.
 */
export const DEFAULT_ROOM = { wakeReserve: 2, createWaitSeconds: 60 }

/** What ran out. */
export type FullBecause = 'servers' | 'running' | 'runtimes' | 'queue'

/** Why a new server on a paid or free plan has no room now; null when it has. */
export function fullFor(room: RoomFacts, rules: RoomRules, paid: boolean): FullBecause | null {
  if (!room.runtimes) return 'runtimes'
  if (room.queuedCreateMs > rules.createWaitMs) return 'queue'
  const share = paid ? 1 : rules.freeShare
  const servers = Math.min(room.controls.maxServers, room.serverCeiling ?? Number.POSITIVE_INFINITY)
  if (room.global.servers >= Math.floor((servers - rules.wakeReserve) * share)) return 'servers'
  const running = room.controls.maxRunningServers - rules.wakeReserve
  if (room.global.running >= Math.floor(running * share)) return 'running'
  return null
}

/** Whether running room is tight: past `tightShare` of what may run at once. */
export const isTight = (room: Pick<RoomFacts, 'controls' | 'global'>, tightShare: number): boolean =>
  room.global.running >= room.controls.maxRunningServers * tightShare
