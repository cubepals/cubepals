// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { PlayerName } from '@blockly/contracts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { isAccountUuid } from '../../minecraft/identity.ts'
import { faceOf } from '../../minecraft/skin.ts'
import type { Limits } from '../ports/limits.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'

/** A new skin shows within the hour. */
const KEPT_MS = 60 * 60_000
/** A lookup Mojang couldn't answer is tried again sooner. */
const RETRY_MS = 5 * 60_000
/** Answers held at once (faces, a couple of hundred bytes each, and names); the oldest goes first. */
const KEPT = 5_000
/** Mojang's own limit is per address, and every Blockly lookup comes from Blockly's. */
const LOOKUPS_PER_MINUTE = 120

/** 8×8 RGBA, opaque; null where the player wears no skin of their own; `unavailable` for now. */
export type Face = Uint8Array | null | 'unavailable'

/**
 * The faces on players' skins, for the rows that list them. Blockly asks Mojang itself, so Mojang
 * learns only that Blockly asked, and a third-party head service learns nothing about who plays
 * on whose server. Where there is no face to show the page draws one of its own, so a face that
 * can't be had right now costs nothing but a moment of the stand-in.
 */
export class PlayerFaces {
  readonly #profiles: PlayerProfiles
  readonly #limits: Limits
  readonly #kept = new Map<string, { until: number; value: unknown }>()
  readonly #asking = new Map<string, Promise<unknown>>()

  constructor(deps: { profiles: PlayerProfiles; limits: Limits }) {
    this.#profiles = deps.profiles
    this.#limits = deps.limits
  }

  /** The face of the account with this UUID. */
  async face(uuid: string): Promise<Face> {
    const key = normalizeUuid(uuid)
    // A player a server made up from a name has no account to ask about; `named` is for them.
    if (!isAccountUuid(key)) return null
    return this.#remembered(`uuid:${key}`, async () => {
      const skin = await this.#profiles.skinOf(key)
      return skin === null ? null : faceOf(skin)
    })
  }

  /**
   * The face of the account that has this name, for a server that doesn't verify accounts: there
   * a player is only a name, and the skin that name's account wears is the one skin plugins give
   * them in game. Null where no account has the name.
   */
  async named(name: string): Promise<Face> {
    const parsed = PlayerName.safeParse(name)
    if (!parsed.success) return null
    const typed = parsed.data
    const account = await this.#remembered(
      `name:${typed.toLowerCase()}`,
      async () => (await this.#profiles.byName(typed))?.uuid ?? null,
    )
    return account === null || account === 'unavailable' ? account : this.face(account)
  }

  /**
   * An answer from Mojang, kept for the hour (five minutes when Mojang couldn't give one), asked
   * for once however many rows want it at the same moment, and counted against Blockly's limit.
   */
  async #remembered<T>(key: string, lookup: () => Promise<T | null>): Promise<T | null | 'unavailable'> {
    const kept = this.#kept.get(key)
    if (kept !== undefined && kept.until > Date.now()) return kept.value as T | null | 'unavailable'
    const asking = this.#asking.get(key)
    if (asking !== undefined) return asking as Promise<T | null | 'unavailable'>
    if (!(await this.#limits.allow('player-faces', LOOKUPS_PER_MINUTE))) return 'unavailable'
    const answer = lookup()
      .then((value) => {
        this.#keep(key, value, KEPT_MS)
        return value
      })
      .catch((error: unknown) => {
        console.warn('player face', key, error instanceof Error ? error.message : error)
        this.#keep(key, 'unavailable', RETRY_MS)
        return 'unavailable' as const
      })
      .finally(() => this.#asking.delete(key))
    this.#asking.set(key, answer)
    return answer
  }

  #keep(key: string, value: unknown, forMs: number): void {
    this.#kept.delete(key)
    if (this.#kept.size >= KEPT) {
      const oldest = this.#kept.keys().next().value
      if (oldest !== undefined) this.#kept.delete(oldest)
    }
    this.#kept.set(key, { until: Date.now() + forMs, value })
  }
}
