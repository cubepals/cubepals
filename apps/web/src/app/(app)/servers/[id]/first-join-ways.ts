// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How to join a new server, a line for each game that can, for the owner's own first join: the
 * one the device they are reading on runs first. Not for the line under the address, which says
 * the version and pack (`joinLine` in `lib/present.ts`).
 */

const JAVA =
  'On a computer, in Minecraft: Java Edition: Multiplayer → Add Server, paste the address, then Join Server.'
const BEDROCK =
  'On a phone, tablet or Windows, in Minecraft: Play → Servers → Add Server, paste the address and keep port 19132.'

/** A phone or tablet, from the browser's own word: it runs Bedrock, never Java Edition. */
export const onPhone = (userAgent: string): boolean => /Android|iPhone|iPad/.test(userAgent)

/** The ways in: Java alone where Bedrock can't join, and Bedrock first on a phone or tablet. */
export function firstJoinWays(bedrock: boolean, phone: boolean): string[] {
  if (!bedrock) return [JAVA]
  return phone ? [BEDROCK, JAVA] : [JAVA, BEDROCK]
}
