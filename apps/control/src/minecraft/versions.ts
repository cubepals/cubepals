// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Loader } from '../domain/revision/revision.ts'

/**
 * The versions Blockly offers. Curated on purpose: each one must have a Java image, loaders
 * that build for it, and a place in the upgrade path. Add a release here after trying it.
 *
 * Every pair below booted on the pinned image with its pinned build: the 26.x and 1.21.8-1.21.11
 * releases on 2026-09-19, and 1.21.1 and 1.20.1 on 2026-09-23. 26.3 has Fabric alone: Paper's
 * builds for it are alpha, NeoForge's beta, Forge has none recommended, and Quilt has no mappings
 * for it yet. 1.20.1 has no NeoForge, whose 1.20.1 line is a fork of Forge with its own scheme.
 *
 * 1.21.1 and 1.20.1 are here because that is where modded Minecraft lives: the mods and modpacks
 * people ask for by name build for them long after newer releases arrive.
 */
interface OfferedVersion {
  id: string
  loaders: readonly Loader[]
}

const EVERY_LOADER: readonly Loader[] = ['vanilla', 'fabric', 'paper', 'quilt', 'neoforge', 'forge']

const OFFERED: readonly OfferedVersion[] = [
  { id: '26.3', loaders: ['vanilla', 'fabric'] },
  { id: '26.2', loaders: EVERY_LOADER },
  { id: '26.1.2', loaders: EVERY_LOADER },
  { id: '1.21.11', loaders: EVERY_LOADER },
  { id: '1.21.10', loaders: EVERY_LOADER },
  { id: '1.21.8', loaders: EVERY_LOADER },
  { id: '1.21.1', loaders: EVERY_LOADER },
  { id: '1.20.1', loaders: ['vanilla', 'fabric', 'paper', 'quilt', 'forge'] },
]

export const DEFAULT_GAME_VERSION = '26.3'
export const DEFAULT_LOADER: Loader = 'vanilla'

export const LOADER_LABELS: Record<Loader, string> = {
  vanilla: 'Vanilla',
  paper: 'Paper',
  fabric: 'Fabric',
  quilt: 'Quilt',
  neoforge: 'NeoForge',
  forge: 'Forge',
}

export function offeredVersions(): readonly OfferedVersion[] {
  return OFFERED
}

/**
 * Loaders in the order Blockly reaches for one, when a vanilla world's owner adds a mod and
 * Blockly picks the server type for them: mod loaders first, Paper last, since Paper runs
 * plugins rather than mods.
 */
const FOR_MODS: readonly Loader[] = ['fabric', 'quilt', 'neoforge', 'forge', 'paper']

/**
 * The server type a vanilla world moves to so it can run mods: the first Blockly offers for that
 * release. Null where it offers none, which would leave the world vanilla.
 */
export function loaderForMods(gameVersion: string): Loader | null {
  const offered = OFFERED.find((version) => version.id === gameVersion)
  if (offered === undefined) return null
  return FOR_MODS.find((loader) => offered.loaders.includes(loader)) ?? null
}

export function supports(gameVersion: string, loader: Loader): boolean {
  return OFFERED.some((v) => v.id === gameVersion && v.loaders.includes(loader))
}

/** The loaders a pack can bring; a pack never runs on Paper or plain Minecraft. */
const PACK_LOADERS: readonly Loader[] = ['fabric', 'quilt', 'neoforge', 'forge']

/**
 * Whether a server can run a pack on this release and loader. Wider than what Blockly offers for
 * a server made from nothing: a pack brings its own loader build and its own mods, and the image
 * installs both, so any release with a Java image and a pack loader is one it runs, from 1.12.2
 * onward; older packs wait until one has booted on the image here. Most packs people ask for by name live on releases Blockly doesn't offer
 * for new vanilla worlds: RLCraft on 1.12.2, All the Mods 6 on 1.16.5, Vault Hunters on 1.18.2.
 */
export function packRuns(gameVersion: string, loader: Loader): boolean {
  if (!PACK_LOADERS.includes(loader)) return false
  if (!/^\d+\.\d+(\.\d+)?$/.test(gameVersion)) return false
  return (
    compareVersions(gameVersion, '1.12.2') >= 0 && compareVersions(gameVersion, DEFAULT_GAME_VERSION) <= 0
  )
}

/** The Java major version a Minecraft release needs. */
export function javaFor(gameVersion: string): 8 | 17 | 21 | 25 {
  const [major = 0, minor = 0, patch = 0] = gameVersion.split('.').map((n) => Number.parseInt(n, 10))
  // Year-numbered releases (26.1 onward) run on Java 25.
  if (major >= 26) return 25
  if (major === 1 && (minor > 20 || (minor === 20 && patch >= 5))) return 21
  if (major === 1 && minor >= 17) return 17
  return 8
}

/**
 * Orders release ids: 1.21.8 < 1.21.10 < 26.1.2 < 26.2. Worlds only move forward, so a change
 * to an older release is refused.
 *
 * Written out rather than taken from `compare-versions` for two reasons, checked 2026-09-23:
 * `minecraft/` imports no packages at all (`scripts/check-boundaries.ts`), and Minecraft's
 * releases are not semantic versions — `26.3` sits beside `1.21.8` — so a library that assumes
 * they are would be right today by accident. The cases that matter are in `minecraft.test.ts`.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}
