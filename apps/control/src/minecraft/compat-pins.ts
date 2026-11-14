// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The exact releases of the plugins Cubepals places on a Paper server itself (`app/compat/`): the
 * Via plugins, Grim for Stop cheaters, and Floodgate for Bedrock players. Each is one release, by
 * its Modrinth version and the SHA-512 of its file, or for Floodgate one GeyserMC build with its
 * permanent link, and one release of each runs on every Minecraft release Paper is offered on.
 *
 * Nothing newer reaches a server because its project published it: a newer release arrives by a
 * change to compat-pins.json, in a pull request (`bun scripts/compat-pins.ts bump`), and a start
 * places a jar only where its bytes hash to the one written there (`carried.ts`). A weekly run
 * (`plugin-pins.yml`) goes red while a newer release is out, since a player's game can move to a
 * new Minecraft before the pinned ViaVersion knows it.
 *
 * The data is JSON so the script can rewrite it. Not for which server gets which plugin
 * (`app/compat/service.ts`), or for the Fabric performance mods (`performance-pins.ts`).
 */
import pins from './compat-pins.json' with { type: 'json' }

/** One release of one plugin on Modrinth: its project and version, and its file's SHA-512. */
export interface CompatPin {
  readonly name: string
  readonly projectId: string
  readonly versionId: string
  readonly label: string
  readonly sha512: string
}

/** One Floodgate build for Paper, as GeyserMC numbers and publishes it, with its permanent link. */
export interface FloodgatePin {
  readonly version: string
  readonly build: number
  readonly fileName: string
  readonly url: string
  readonly sha512: string
  readonly sizeBytes: number
}

/** What Cubepals places on Paper servers: the Modrinth plugins, and Floodgate where Bedrock is on. */
export interface CompatPins {
  readonly plugins: readonly CompatPin[]
  readonly floodgate: FloodgatePin | null
}

export const COMPAT_PINS: CompatPins = pins
