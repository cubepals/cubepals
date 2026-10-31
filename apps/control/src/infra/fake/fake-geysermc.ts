// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { FloodgateJar, GeyserMc } from '../../app/ports/geysermc.ts'

/**
 * GeyserMC, offline: one Floodgate build a test publishes or takes away, and the gamertags a test
 * introduces, each with the XUID it is given, and the skins a test dresses them in. Any other
 * gamertag is unknown, as to the real lookup.
 */
export class FakeGeyserMc implements GeyserMc {
  /** The Floodgate build GeyserMC lists; none until a test publishes one. */
  floodgate: FloodgateJar | null = null
  /** Whether GeyserMC can be asked at all. */
  down = false
  readonly #xuids = new Map<string, string>()
  readonly #skins = new Map<string, string>()

  /** The gamertag is known, with this XUID. */
  introduce(gamertag: string, xuid: string): void {
    this.#xuids.set(gamertag.toLowerCase(), xuid)
  }

  /** The Bedrock player with this XUID wears the skin with this texture id, as if Geyser had uploaded it. */
  dress(xuid: string, textureId: string): void {
    this.#skins.set(xuid, textureId)
  }

  async latestFloodgate(): Promise<FloodgateJar | null> {
    if (this.down) throw new Error('GeyserMC answered 503')
    return this.floodgate
  }

  async xuidOf(gamertag: string): Promise<string | null> {
    if (this.down) throw new Error('GeyserMC answered 503')
    return this.#xuids.get(gamertag.toLowerCase()) ?? null
  }

  async skinTextureOf(xuid: string): Promise<string | null> {
    if (this.down) throw new Error('GeyserMC answered 503')
    return this.#skins.get(xuid) ?? null
  }
}
