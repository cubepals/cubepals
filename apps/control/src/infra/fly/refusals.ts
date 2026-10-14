// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Fly Machines API says when it refuses a call, wherever the adapter acts on the words.
 * Fly's error body is `{ error, status? }` with English in `error` and, mostly, no code to match
 * instead (https://fly.io/docs/machines/api/working-with-machines-api/), so each refusal the
 * adapter tells apart is written here once, as Fly was seen to say it: the adapter matches with
 * it, and the fake Fly and the tests say it with it. Refusals the adapter treats alike, whatever
 * their words, are not here.
 */

/**
 * The status Fly's error carries when a host has no room for a machine. Its words say which room
 * ran out: CPUs (iad volume hosts, January to March 2026) or memory.
 */
export const NO_ROOM_STATUS = 'insufficient_capacity'
const NO_CPUS = 'insufficient CPUs available'
const NO_MEMORY = 'insufficient memory available'
export const NO_CPUS_SAID = `aborted: could not reserve resource for machine: ${NO_CPUS} to fulfill request`
export const NO_MEMORY_SAID = `insufficient resources available to fulfill request: ${NO_MEMORY} to fulfill request`
const NO_ROOM = new RegExp(`${NO_CPUS}|${NO_MEMORY}`, 'i')

/** Whether a refusal, by its words or its status, is a host with no room for the machine. */
export const saysNoRoom = (said: string, status: unknown): boolean =>
  status === NO_ROOM_STATUS || NO_ROOM.test(said)

/**
 * A new machine refused because the organization holds as many machines as Fly lets it, stopped
 * ones included. Fly's words, as flyctl prints them (community.fly.io/t/14701 and /t/18014); the
 * API answers 422 (community.fly.io/t/10880). Fly documents neither the body nor a code, so the
 * words are matched.
 */
const AT_LIMIT = 'reached the maximum number of machines'
export const AT_LIMIT_SAID = `You have ${AT_LIMIT} for this app`
const AT_LIMIT_MATCH = new RegExp(AT_LIMIT, 'i')
export const saysAtLimit = (said: string): boolean => AT_LIMIT_MATCH.test(said)

/**
 * A new machine refused, 412, because another machine holds the volume it mounts. Fly can go on
 * holding it for a machine it has destroyed, and then names `NO_MACHINE` (production, 2026-10-10).
 */
const CLAIMED = 'already claimed'
export const NO_MACHINE = '\u0000'.repeat(14)
export const volumeClaimed = (machineId: string) =>
  `failed_precondition: volume ${CLAIMED} by machine ${machineId}`
const CLAIMED_MATCH = new RegExp(CLAIMED, 'i')
export const saysClaimed = (error: unknown): boolean => CLAIMED_MATCH.test(JSON.stringify(error ?? ''))

/** A volume's delete refused, 412, while a machine is still bound to it (seen on staging). */
const BOUND = 'bound to machine'
export const volumeBound = (machineId: string) =>
  `failed_precondition: volume is currently ${BOUND}: ${machineId}`
const BOUND_MATCH = new RegExp(BOUND, 'i')
export const saysBound = (error: unknown): boolean => BOUND_MATCH.test(JSON.stringify(error ?? ''))

/**
 * A start refused only until Fly has settled the machine: 412 while it is being prepared, stopped
 * or suspended, or while Fly finishes a stop it already reports done (staging, 2026-10-07); 409
 * straight after a suspend, while Fly still writes its memory out (staging, 2026-10-11).
 */
const REFUSING = 'refusing to start'
const FROM_STATE = 'unable to start machine from current state'
const STOPPING = 'failed to start, currently stopping'
export const STILL_ACTIVE_SAID = `failed_precondition: machine still active, ${REFUSING}`
export const CURRENTLY_STOPPING_SAID = `aborted: machine ${STOPPING}`
export const unableToStart = (state: string) => `failed_precondition: ${FROM_STATE}: '${state}'`
const NOT_YET = new RegExp(
  `${REFUSING}|${FROM_STATE}: '(?:created|replacing|stopping|suspending)'|${STOPPING}`,
)
export const saysNotYet = (error: unknown): boolean => NOT_YET.test(JSON.stringify(error ?? ''))

/** A snapshot refused, 412, while one is being written, saying when that one began. */
const SCHEDULED = 'already scheduled at'
export const snapshotScheduled = (at: string) => `failed_precondition: snapshot is ${SCHEDULED} ${at}`
const SCHEDULED_MATCH = new RegExp(`${SCHEDULED} ([0-9T:.-]+Z)`)

/** When the snapshot a refusal points at was scheduled, if it is that refusal. */
export function scheduledAt(error: unknown): number | null {
  const said = JSON.stringify(error ?? '').match(SCHEDULED_MATCH)?.[1]
  const at = said === undefined ? Number.NaN : Date.parse(said)
  return Number.isNaN(at) ? null : at
}
