// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { BLOCKLY_ICON, type PlayIcon } from '@blockly/contracts'

const COVERS = [
  '/imagery/cover-snow.jpg',
  '/imagery/cover-canyon.jpg',
  '/imagery/cover-cherry.jpg',
  '/imagery/cover-island.jpg',
] as const

/**
 * A server's own picture as the pages draw it: the one its owner gave it, or the one they picked,
 * or Blockly's.
 */
export const iconSrc = (icon: string | null, ownIcon: string | null = null): string =>
  ownIcon ?? `/server-icons/${icon ?? BLOCKLY_ICON}.svg`

/** A way to play's picture on the create page: an item, drawn by scripts/play-icons.py. */
export const playIconSrc = (icon: PlayIcon): string => `/play-icons/${icon}.svg`

/** A server's card picture. The tail of its id is random, so a server keeps the same one. */
export function coverFor(serverId: string): string {
  return COVERS[Number.parseInt(serverId.slice(-8), 16) % COVERS.length] ?? COVERS[0]
}
