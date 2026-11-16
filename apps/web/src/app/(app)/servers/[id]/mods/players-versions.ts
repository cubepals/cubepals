// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModPlanView } from '@blockly/contracts'

type Updated = Extract<ModPlanView, { kind: 'ok' }>['updated']

/**
 * What a mod change's confirmation says of the updates a player's game can carry: a game that has
 * one joins only with its new version once the change applies, as a game with an older copy is cut
 * off as it joins. Each is named with that version. Empty when the change moves none of them.
 */
export function playersVersions(updated: Updated): string {
  const moved = updated.filter((update) => update.carried === true).map(({ to }) => to)
  const [only] = moved
  if (only === undefined) return ''
  if (moved.length === 1)
    return `Players who have ${only.name} in their game need ${only.versionLabel} to join. `
  const named = moved.map((mod) => `${mod.name} ${mod.versionLabel}`)
  return `Players who have these in their game need the new versions to join: ${named.slice(0, -1).join(', ')} and ${named.at(-1)}. `
}
