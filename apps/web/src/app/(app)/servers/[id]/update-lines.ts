// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server's page and its Mods page say about the updates Cubepals found by itself: a newer
 * pack, or newer versions of the mods it runs, checked to run together before they are offered.
 * The same words in both places. Not for applying one: that is the Mods page's plan, as any change.
 */

import type { ModsView, ModUpdatesView, ModView } from '@blockly/contracts'

/** The Mods page's address that opens the update, ready to apply, from anywhere else. */
export const updateHref = (serverId: string) => `/servers/${serverId}/mods?update=all`

/** The versions found, by mod; none while they are being looked for, or couldn't be. */
export type Versions = ModUpdatesView['versions']

/** The version a mod can update to, or null. */
export const updateOf = (mod: Pick<ModView, 'id'>, versions: Versions): string | null =>
  versions[mod.id] ?? null

/** The server's mods with an update, as the Mods page offers them all at once. */
export const withUpdates = (list: Pick<ModsView, 'mods'>, versions: Versions): ModView[] =>
  list.mods.filter((mod) => updateOf(mod, versions) !== null)

/** One sentence about what is newer; null when nothing is. */
export function updatesLine(
  list: Pick<ModsView, 'kind' | 'mods' | 'modpack' | 'packUpdate'>,
  versions: Versions,
): string | null {
  if (list.modpack !== null) {
    const update = list.packUpdate
    if (update === null) return null
    return `${list.modpack.name} ${update.label} is out${update.movesWorld ? `, on Minecraft ${update.gameVersion}` : ''}.`
  }
  const mods = withUpdates(list, versions)
  const noun = list.kind === 'plugins' ? 'plugins' : list.kind === 'datapacks' ? 'datapacks' : 'mods'
  const [only] = mods
  if (only === undefined) return null
  if (mods.length === 1)
    return `${only.name} ${updateOf(only, versions)} is out. Cubepals checked it runs with your other ${noun}.`
  return `Updates for ${namesOf(mods.map((mod) => mod.name))} are out. Cubepals checked they run together with your other ${noun}.`
}

/** Names as a sentence reads them: "A and B", "A, B, C and 4 more". */
function namesOf(names: readonly string[]): string {
  if (names.length > 4) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
