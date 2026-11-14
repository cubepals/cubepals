// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pins a test's catalog stands for, in place of `minecraft/compat-pins.json`, whose releases
 * no test catalog publishes: for each plugin the real pins name, the newest listed release the
 * catalog has for any release Cubepals offers, and the Floodgate build a fake GeyserMC lists. The
 * compat job then pins exactly these, as it pins the real ones in production.
 */
import type { ModCatalog } from '../app/ports/catalog.ts'
import type { FloodgateJar } from '../app/ports/geysermc.ts'
import { COMPAT_PINS, type CompatPin, type CompatPins } from '../minecraft/compat-pins.ts'
import { catalogLoadersFor } from '../minecraft/mods.ts'
import { offeredVersions } from '../minecraft/versions.ts'

export async function catalogPins(
  catalog: ModCatalog,
  floodgate: FloodgateJar | null = null,
): Promise<CompatPins> {
  const loaders = catalogLoadersFor('paper')
  const plugins: CompatPin[] = []
  for (const pin of COMPAT_PINS.plugins) {
    const lists = await Promise.all(
      offeredVersions().map((offered) =>
        catalog.versions(pin.projectId, { loaders, gameVersion: offered.id }),
      ),
    )
    const newest = lists
      .flat()
      .filter((version) => version.state === 'listed')
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0]
    if (newest !== undefined)
      plugins.push({
        ...pin,
        versionId: newest.versionId,
        label: newest.versionLabel,
        sha512: newest.file.sha512,
      })
  }
  return { plugins, floodgate }
}
