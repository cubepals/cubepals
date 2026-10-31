// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server types a world's `level.dat` names as having opened it (`Data.ServerBrands`), and which
 * of them add blocks and items of their own. The control plane reads them from the world it is sent
 * and the browser from the world before it is sent, so both say the same of it.
 */

/** Server types that run plain Minecraft's blocks and items, whatever they add besides. */
const PLAIN_BRANDS: ReadonlySet<string> = new Set([
  'vanilla',
  'paper',
  'spigot',
  'craftbukkit',
  'bukkit',
  'purpur',
  'folia',
])

/** Of the server types a world names, lowercase and once each, those that add blocks and items. */
export function moddedOf(brands: readonly string[]): string[] {
  const named = brands.map((brand) => brand.trim().toLowerCase()).filter((brand) => brand !== '')
  return [...new Set(named)].filter((brand) => !PLAIN_BRANDS.has(brand))
}
