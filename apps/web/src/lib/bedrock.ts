// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the public pages say Bedrock friends can join, or that it is coming. One switch,
 * WEB_BEDROCK, set to `1` by the deploy exactly when the control plane it deploys beside has
 * Bedrock (the FLOODGATE_KEY it was given). Missing or anything else is off, so a page never says
 * Bedrock works where it doesn't. Not for the server page, which reads the server's own setting.
 */

/** Whether the public pages say Bedrock works: the deployment sets WEB_BEDROCK to `1`. */
export const bedrockLive = (): boolean => process.env.WEB_BEDROCK === '1'

/** The small print under the hero's button, after the trial's line: where Bedrock is off, that it is coming. */
export const heroSmallPrint = (live: boolean): string | null =>
  live ? null : 'Minecraft: Java Edition. Bedrock is coming soon.'
