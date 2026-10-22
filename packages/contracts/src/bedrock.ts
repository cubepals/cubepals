// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a Bedrock player appears on a Paper server. Floodgate logs them in as a Java player with a
 * name that starts with a dot and a UUID made from their Xbox user id (XUID): the XUID in the low
 * 64 bits, zero in the high 64. No Minecraft account has such a UUID (Mojang's are version 4, a
 * server that doesn't check accounts makes version 3 ones), so the UUID alone says who is on Bedrock.
 *
 * Measured on Floodgate 2.2.5 with Paper 26.2: name `.Example`, UUID
 * `00000000-0000-0000-0009-01eed05d1000`. Not for how a gamertag becomes an XUID: that is a lookup
 * the control plane makes.
 */
import type { BedrockView } from './server.ts'

/** The prefix Floodgate gives every Bedrock player's name, in its default configuration. */
const FLOODGATE_PREFIX = '.'

/** Minecraft names are at most 16 characters, the prefix included; Floodgate cuts longer ones. */
const NAME_LENGTH = 16

/** The UUID Floodgate gives the player with this XUID (a decimal string, as Xbox lists it). */
export function floodgateUuid(xuid: string): string {
  const hex = BigInt(xuid).toString(16).padStart(16, '0')
  return `00000000-0000-0000-${hex.slice(0, 4)}-${hex.slice(4)}`
}

/** Whether a UUID is a Bedrock player's, made by Floodgate from their XUID. */
export const isBedrockUuid = (uuid: string): boolean =>
  /^00000000-?0000-?0000-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(uuid)

/** The name Floodgate gives a gamertag: the prefix, spaces as underscores, cut to a Minecraft name's length. */
export const floodgateName = (gamertag: string): string =>
  `${FLOODGATE_PREFIX}${gamertag.trim().replaceAll(' ', '_')}`.slice(0, NAME_LENGTH)

/** The name a Bedrock player is shown by: their gamertag as Floodgate kept it, without its prefix. */
export const bedrockDisplayName = (name: string): string =>
  name.startsWith(FLOODGATE_PREFIX) ? name.slice(FLOODGATE_PREFIX.length) : name

/** Whether a typed name asks for a Bedrock player: it starts the way Floodgate's names do. */
export const typedAsBedrock = (typed: string): boolean => typed.trim().startsWith(FLOODGATE_PREFIX)

/**
 * Whether text can be a gamertag, typed with Floodgate's dot or without: letters, numbers and
 * spaces, up to 15 of them. Only ASCII ones, since the server's player argument reads no others,
 * and a name with any other fails its command on every sync. Whether an account has it is the
 * lookup's to say.
 */
export const isGamertag = (typed: string): boolean => /^\.?[A-Za-z0-9][A-Za-z0-9 ]{0,14}$/.test(typed.trim())

/** A player as a page names them: the gamertag for a Bedrock player, the name for any other. */
export const shownName = (player: { uuid: string; name: string }): string =>
  isBedrockUuid(player.uuid) ? bedrockDisplayName(player.name) : player.name

/** Whether Bedrock players can join a server now: its choice is on and its other versions leave room for it. */
export const letsBedrockIn = (server: { bedrock: BedrockView | null | false }): boolean =>
  server.bedrock !== null &&
  server.bedrock !== false &&
  server.bedrock.on &&
  !server.bedrock.needsOtherVersions
