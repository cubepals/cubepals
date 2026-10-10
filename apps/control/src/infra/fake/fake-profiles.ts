// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import type { PlayerProfiles, SkinPixels } from '../../app/ports/minecraft.ts'

/**
 * Mojang's profile lookups, offline. Every valid player name has an account whose UUID is derived
 * from the name, so the same name always gets the same player; like Mojang's own, it is a version
 * 4 UUID, never the one a server that doesn't verify accounts would derive from the same name.
 * Names added as unknown have none, as a name nobody owns. Nobody wears a skin of their own
 * until a test dresses them.
 */
export class FakeProfiles implements PlayerProfiles {
  readonly #unknown = new Set<string>()
  readonly #renamed = new Map<string, string>()
  readonly #byUuid = new Map<string, { uuid: string; name: string }>()
  readonly #skins = new Map<string, SkinPixels>()
  /** How many times a skin was asked for, answered or not. */
  skinLookups = 0

  /** Nobody owns this name. */
  unknown(name: string): void {
    this.#unknown.add(name.toLowerCase())
  }

  /** The player behind `from` now goes by `to`; `from` is free. */
  rename(from: string, to: string): void {
    this.#renamed.set(to.toLowerCase(), uuidFor(from))
    this.#unknown.add(from.toLowerCase())
    this.#byUuid.set(uuidFor(from), { uuid: uuidFor(from), name: to })
  }

  /** The player with this name now wears this skin. */
  wear(name: string, skin: SkinPixels): void {
    this.#skins.set(uuidFor(name), skin)
  }

  async byName(name: string): Promise<{ uuid: string; name: string } | null> {
    const lower = name.toLowerCase()
    if (!/^[a-z0-9_]{3,16}$/.test(lower)) return null
    const moved = this.#renamed.get(lower)
    if (moved !== undefined) return { uuid: moved, name }
    if (this.#unknown.has(lower)) return null
    const profile = { uuid: uuidFor(name), name }
    this.#byUuid.set(profile.uuid, profile)
    return profile
  }

  async byUuid(uuid: string): Promise<{ uuid: string; name: string } | null> {
    return this.#byUuid.get(uuid.replace(/-/g, '').toLowerCase()) ?? null
  }

  async skinOf(uuid: string): Promise<SkinPixels | null> {
    this.skinLookups++
    return this.#skins.get(uuid.replace(/-/g, '').toLowerCase()) ?? null
  }
}

/** An account's UUID, undashed as Mojang's API gives it: version 4, and the same for the same name. */
function uuidFor(name: string): string {
  const hash = createHash('md5').update(`account:${name.toLowerCase()}`).digest()
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x40
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  return hash.toString('hex')
}
