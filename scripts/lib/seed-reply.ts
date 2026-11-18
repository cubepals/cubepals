// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seed in the console's answer to `seed`, which Minecraft gives as `Seed: [<number>]`. The
 * staging check tells worlds apart by it, so an answer that isn't that one is refused with what it
 * said: another command's answer reaching this one (the spawn warm-up's "49 force loaded chunks")
 * must not read as a seed.
 */
const SEED_REPLY = /Seed: \[(-?\d+)\]/

export function seedIn(reply: string): string {
  const seed = SEED_REPLY.exec(reply)?.[1]
  if (seed === undefined) throw new Error(`the console answered "${reply.trim()}" to seed`)
  return seed
}
