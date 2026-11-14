// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server's page and its Mods page say about the updates Cubepals found by itself: a newer
 * pack, or newer versions of the mods it runs, checked to run together before they are offered.
 * The same words in both places. Not for applying one: that is the Mods page's plan, as any change.
 */

import { type ModsView, type ModUpdatesView, type ModView, updatesSaid } from '@blockly/contracts'

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
  const noun = list.kind === 'plugins' ? 'plugins' : list.kind === 'datapacks' ? 'datapacks' : 'mods'
  return updatesSaid(
    withUpdates(list, versions).map((mod) => ({ name: mod.name, version: updateOf(mod, versions) ?? '' })),
    noun,
  )
}
