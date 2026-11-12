/**
 * SPDX-FileCopyrightText: 2026 The Cubepals Authors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Which size the game settings need, as the settings page works it out while the owner slides:
 * the smallest size the plan has, no smaller than the server's own, that holds the players and
 * keeps up easily with the distances (`load.ts`). Cubepals moves a server up for what the owner
 * asked of it and never down on its own: a smaller size is the owner's to choose. Rendering, and
 * the owner's own choice of size, live in `use-sizing.ts`.
 */
import type { PartySize } from '@blockly/contracts'
import { EASY, workload } from './load'

/** A size as the settings page lists it (`SettingsOptions.partySizes`). */
export interface SizeChoice {
  value: PartySize
  label: string
  maxPlayers: number
  /** The most players its machine takes on this plan: the load is measured against it. */
  holds: number
  allowed: boolean
  reason?: string
}

/**
 * A size to measure from: the server's own as it is, or the one the owner picked. `holds` is how
 * far max players goes on it, and `capacity` what its machine takes; the server's own size has
 * both from the page's bounds.
 */
export interface Current {
  size: PartySize
  holds: number
  capacity: number
}

/** What a game asks of a size: everyone on at once, at these distances. */
export interface Want {
  players: number
  view: number
  simulation: number
}

/**
 * How far max players goes on a size: the one measured from what it says, another its group, so a
 * size picked for thirty players reads "Up to 50", never "Up to 20".
 */
export const holdsOf = (size: SizeChoice, current: Current): number =>
  size.value === current.size ? current.holds : size.maxPlayers

/** What a size's machine takes: the load is measured against it, not against its group. */
export const capacityOf = (size: SizeChoice, current: Current): number =>
  size.value === current.size ? current.capacity : size.holds

/** The sizes from the server's own upward, smallest first; all of them when its own isn't listed. */
function fromCurrent(sizes: readonly SizeChoice[], current: Current): SizeChoice[] {
  const sorted = [...sizes].sort((a, b) => a.maxPlayers - b.maxPlayers)
  const at = sorted.findIndex((size) => size.value === current.size)
  return at < 0 ? sorted : sorted.slice(at)
}

/** Whether a size holds everyone and keeps up easily with them. */
const keepsUp = (size: SizeChoice, want: Want, current: Current): boolean =>
  want.players <= holdsOf(size, current) && workload({ ...want, holds: capacityOf(size, current) }) <= EASY

/**
 * The size a game needs: the smallest the plan has, from the server's own up, that keeps up;
 * else the biggest it has that holds everyone; else the server's own.
 */
export function neededSize(want: Want, sizes: readonly SizeChoice[], current: Current): PartySize {
  const usable = fromCurrent(sizes, current).filter((size) => size.allowed || size.value === current.size)
  const fits = usable.find((size) => keepsUp(size, want, current))
  if (fits) return fits.value
  const holding = usable.filter((size) => want.players <= holdsOf(size, current)).at(-1)
  return holding?.value ?? current.size
}

/** A bigger size that would keep up but the plan doesn't have, for the page to name its plan. */
export const lockedFit = (
  want: Want,
  sizes: readonly SizeChoice[],
  current: Current,
): SizeChoice | undefined =>
  fromCurrent(sizes, current).find((size) => !size.allowed && keepsUp(size, want, current))

/** The most players any size the plan has holds: how far the players slider goes. */
export const mostPlayers = (sizes: readonly SizeChoice[], current: Current): number =>
  Math.max(current.holds, ...sizes.filter((size) => size.allowed).map((size) => holdsOf(size, current)))

/** Which size is bigger, by how many it holds: positive when `a` is. */
export const compareSizes = (a: SizeChoice | undefined, b: SizeChoice | undefined): number =>
  (a?.maxPlayers ?? 0) - (b?.maxPlayers ?? 0)
