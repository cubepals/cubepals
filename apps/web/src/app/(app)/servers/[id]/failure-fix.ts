// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a failed server's one fix takes its owner, by the remedy its own output was read as
 * (`apps/control/src/minecraft/diagnosis.ts`). Only the fixes that are a page elsewhere; a bigger
 * size is a button of the failure's own, and a remedy with no page has none.
 */
export function failureFix(
  serverId: string,
  remedy: string | null,
  during: string | undefined,
): { label: string; href: string } | null {
  switch (remedy) {
    case 'modpack':
      // Its first build failed on the pack: nothing was ever in it, so the way out is another
      // pack, under the same name and address.
      return during === 'provisioning'
        ? { label: 'Pick another pack', href: `/servers/new?replace=${serverId}` }
        : { label: 'Look at its modpack', href: `/servers/${serverId}/mods` }
    case 'mods':
      return { label: 'Change its mods', href: `/servers/${serverId}/mods` }
    case 'newer_minecraft':
      // A world from a newer release can't go back to an older one: the version is chosen where it
      // always is, which says what moving up does before it is done.
      return { label: 'Change its Minecraft', href: `/servers/${serverId}/settings#version` }
    case 'restore':
      return { label: 'Restore a backup', href: `/servers/${serverId}/backups` }
    default:
      return null
  }
}
