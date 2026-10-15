// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turns an answer from the Fly Machines API into its value or the error it means: a `FlyApiError`,
 * or the port's `RuntimeFull` when a host has no room. It makes no calls of its own; which call
 * to make, and what a 404 means for it, belongs to the part that owns the resource.
 */

import { HostFull, RuntimeAtLimit, RuntimeFull } from '../../../app/ports/runtime.ts'
import { FlyApiError } from '../client.ts'
import { saysAtLimit, saysNoRoom } from '../refusals.ts'

export type Result<T> = { data?: T; error?: unknown; response: Response }

export function must<T>(result: Result<T>, what: string): T {
  if (!result.response.ok) throw new FlyApiError(result.response.status, what, result.error)
  return result.data as T
}

/** For calls whose success carries no body worth reading. */
export function succeeded(result: Result<unknown>, what: string, ...alsoFine: number[]): void {
  if (!result.response.ok && !alsoFine.includes(result.response.status))
    throw new FlyApiError(result.response.status, what, result.error)
}

/**
 * `must`, for starting, making or resizing a machine: a host with no room for it is the port's
 * RuntimeFull, which a wait passes, as on any full runtime, and the organization at its machine
 * limit is RuntimeAtLimit. `onItsHost`, for a machine that exists: its volume ties it to its
 * host, so no room there is HostFull. Anything else Fly says stays a Fly error.
 */
export function launched<T>(result: Result<T>, what: string, onItsHost = false): T {
  if (!result.response.ok) {
    const { said, status } = refusalOf(result.error)
    if (saysAtLimit(said)) throw new RuntimeAtLimit('fly', `${what}: ${said}`)
    if (saysNoRoom(said, status))
      throw onItsHost ? new HostFull('fly', `${what}: ${said}`) : new RuntimeFull('fly', `${what}: ${said}`)
  }
  return must(result, what)
}

/** What a refusal said, and its status, where Fly's error body carries them. */
function refusalOf(error: unknown): { said: string; status: unknown } {
  if (typeof error === 'object' && error !== null && 'error' in error)
    return { said: String(error.error), status: 'status' in error ? error.status : undefined }
  return { said: String(error ?? ''), status: undefined }
}

export const idOf = (resource: { id?: string }, what: string): string => {
  if (!resource.id) throw new Error(`Fly returned ${what} without an id`)
  return resource.id
}
