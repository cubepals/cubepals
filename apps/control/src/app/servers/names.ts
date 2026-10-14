// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which names and addresses an actor may give a server. Offensive ones nobody gives
 * (`@blockly/contracts/names`). Of the ones held back (`domain/server/held-names.ts`), names that
 * pass for Cubepals or Mojang are an operator's alone, and names held for Cubepals' own servers
 * an operator's or a platform admin's; a player is told they are taken. A server that already
 * has one keeps it: this is asked only when a name or address is chosen.
 */
import { offensive, PICK_ANOTHER_NAME } from '@blockly/contracts/names'
import { holdOn } from '../../domain/server/held-names.ts'
import type { Actor } from '../actor.ts'
import { AppError } from '../errors.ts'

/** Whether `actor` may give a server this address, as far as what it says goes. */
export function mayGive(actor: Actor, slug: string): boolean {
  if (offensive(slug)) return false
  const hold = holdOn(slug)
  return hold === null || actor.kind === 'operator' || (hold === 'cubepals' && actor.kind === 'admin')
}

/** Refuses an address `actor` may not give a server, in the words a player reads. */
export function refuseAddress(actor: Actor, slug: string): void {
  if (offensive(slug)) throw new AppError('slug_invalid', PICK_ANOTHER_NAME)
  if (!mayGive(actor, slug)) throw new AppError('slug_taken', 'That address is taken — try adding a word.')
}

/** A new name for a server as a change to it; the name it already has stays, whatever it is. */
export function renamed(current: string, name: string | undefined): { name?: string } {
  if (name === undefined || name === current) return {}
  if (offensive(name)) throw new AppError('invalid_name', PICK_ANOTHER_NAME)
  return { name }
}

/**
 * A new server's name, and the address asked for, unless the server it replaces hands its own
 * over: that one is the owner's already.
 */
export function checkNewServer(
  actor: Actor,
  request: { name: string; slug?: string | undefined; replaces?: string | undefined },
): void {
  if (offensive(request.name)) throw new AppError('invalid_name', PICK_ANOTHER_NAME)
  if (request.slug !== undefined && request.replaces === undefined) refuseAddress(actor, request.slug)
}
