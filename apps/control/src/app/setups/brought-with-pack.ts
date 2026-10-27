// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world played with mods, made into a server from the pack it was played with
 * (docs/world-import.md § Mods and plugins): which version of a catalog pack plays it, and what
 * the pack resolves to, fitted to the world. Resolving the pack is `service.ts`'s, as for any pack.
 */
import type { PackSourceInput } from '@blockly/contracts'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import type { ServerSetup } from '../../domain/setup/setup.ts'
import { compareVersions } from '../../minecraft/versions.ts'
import type { BroughtWorld } from '../backups/new-world-imports.ts'
import { AppError } from '../errors.ts'

/** Why a world played with mods isn't made into a server alone: plain Minecraft would lose its blocks and items. */
export const PLAYED_WITH_MODS =
  'This world was played with mods, which plain Minecraft would lose. Choose the pack it was played with, and its server is made from that.'

/**
 * The pack to resolve for a world: one from the catalog named without a version plays its newest
 * version that lists the world's own release, where it has one, so the world isn't moved to a
 * newer Minecraft unasked.
 */
export async function packForWorld(
  pack: PackSourceInput,
  brought: BroughtWorld,
  versions: (
    projectId: string,
  ) => Promise<ReadonlyArray<Pick<CatalogVersion, 'versionId' | 'gameVersions' | 'publishedAt'>>>,
): Promise<PackSourceInput> {
  if (pack.kind !== 'modpack' || pack.versionId !== undefined) return pack
  const own = [...(await versions(pack.projectId))]
    .filter((version) => version.gameVersions.includes(brought.facts.playsOn))
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0]
  return own === undefined ? pack : { ...pack, versionId: own.versionId }
}

/**
 * What a pack resolved to, fitted to the world its server starts on: the pack decides what it
 * runs, the world its game mode, difficulty and type, and the disk it needs. A world last saved on
 * a newer Minecraft than the pack's would lose what that release added, so it is refused; one
 * the pack would update is only where its owner chose the pack's version (`pack`), the file or
 * the release Cubepals offers, never a version Cubepals picked for them.
 */
export function fittedToWorld<
  R extends { gameVersion: string; from: string; notes: string[]; setup: ServerSetup },
>(resolved: R, brought: BroughtWorld, pack: PackSourceInput): R & { brought: BroughtWorld } {
  const { facts } = brought
  if (compareVersions(facts.playsOn, resolved.gameVersion) > 0)
    throw new AppError(
      'invalid_choice',
      `This world was last played on Minecraft ${facts.gameVersion}, and ${resolved.from} runs ${resolved.gameVersion}, which can’t open it. Choose the version of the pack the world was played with.`,
    )
  // Moving a world to a newer Minecraft can't be undone: only where its owner chose the version.
  if (facts.playsOn !== resolved.gameVersion && pack.kind === 'modpack' && pack.versionId === undefined)
    throw new AppError(
      'invalid_choice',
      `No version of ${resolved.from} runs Minecraft ${facts.playsOn}, which this world was played on. Choose the version it was played with, or one on a newer Minecraft to update the world to.`,
    )
  const updated = facts.gameVersion !== resolved.gameVersion
  return {
    ...resolved,
    setup: {
      ...resolved.setup,
      settings: { ...resolved.setup.settings, defaultGameMode: facts.gameMode, difficulty: facts.difficulty },
      world: { levelType: facts.levelType, hardcore: facts.hardcore },
    },
    notes: [
      ...resolved.notes,
      ...(updated
        ? [
            `It was last played on Minecraft ${facts.gameVersion}. ${resolved.from} runs ${resolved.gameVersion}, which updates it when it first starts.`,
          ]
        : []),
    ],
    brought,
  }
}
