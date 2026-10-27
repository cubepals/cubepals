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
import { loaderOfPack, serverEnvironment } from '../../minecraft/mods.ts'
import { compareVersions, isRelease, packRuns } from '../../minecraft/versions.ts'
import type { BroughtWorld } from '../backups/new-world-imports.ts'
import { AppError } from '../errors.ts'

/** Why a world played with mods isn't made into a server alone: plain Minecraft would lose its blocks and items. */
export const PLAYED_WITH_MODS =
  'This world was played with mods, which plain Minecraft would lose. Choose the pack it was played with, and its server is made from that.'

/**
 * The release a world was last saved on, where that is a release; the one Cubepals opens it on
 * (`playsOn`) for a snapshot, which no pack lists.
 */
const ownRelease = (facts: BroughtWorld['facts']): string =>
  isRelease(facts.gameVersion) ? facts.gameVersion : facts.playsOn

/** A catalog pack's version, as far as choosing one for a world goes. */
type ListedVersion = Pick<
  CatalogVersion,
  'versionId' | 'gameVersions' | 'publishedAt' | 'environment' | 'loaders'
>

/**
 * Whether a server can play this version on `release`, as resolving a pack judges it
 * (`#pack` in `service.ts`): one for servers, on a server type Cubepals runs it on, listing it.
 */
function runsOnServer(version: ListedVersion, release: string): boolean {
  const loader = loaderOfPack(version.loaders)
  return (
    serverEnvironment(version.environment) !== null &&
    loader !== null &&
    version.gameVersions.includes(release) &&
    packRuns(release, loader)
  )
}

/**
 * The pack to resolve for a world: one from the catalog named without a version plays its newest
 * version a server runs that lists the world's own release, else the one Cubepals opens it on, so
 * the world isn't moved to a newer Minecraft unasked.
 */
export async function packForWorld(
  pack: PackSourceInput,
  brought: BroughtWorld,
  versions: (projectId: string) => Promise<ReadonlyArray<ListedVersion>>,
): Promise<PackSourceInput> {
  if (pack.kind !== 'modpack' || pack.versionId !== undefined) return pack
  const listed = await versions(pack.projectId)
  const newest = (release: string) =>
    [...listed]
      .filter((version) => runsOnServer(version, release))
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0]
  const own = newest(ownRelease(brought.facts)) ?? newest(brought.facts.playsOn)
  return own === undefined ? pack : { ...pack, versionId: own.versionId }
}

/**
 * What a pack resolved to, fitted to the world its server starts on: the pack decides what it
 * runs, the world its game mode, difficulty and type, and the disk it needs. A world last saved on
 * a newer Minecraft than the pack's would lose what that release added, so it is refused; one
 * the pack would update is only where its owner chose the pack's version or file (`pack`), never
 * a newest version Cubepals took for them.
 */
export function fittedToWorld<
  R extends { gameVersion: string; from: string; notes: string[]; setup: ServerSetup },
>(resolved: R, brought: BroughtWorld, pack: PackSourceInput): R & { brought: BroughtWorld } {
  const { facts } = brought
  const own = ownRelease(facts)
  if (compareVersions(own, resolved.gameVersion) > 0)
    throw new AppError(
      'invalid_choice',
      `This world was last played on Minecraft ${facts.gameVersion}, and ${resolved.from} runs ${resolved.gameVersion}, which can’t open it. Choose the version of the pack the world was played with.`,
    )
  // Moving a world to a newer Minecraft can't be undone: only where its owner chose the version,
  // never a newest one Cubepals took for them, from the catalog or among the releases it offers.
  const versionTaken =
    (pack.kind === 'modpack' && pack.versionId === undefined) ||
    (pack.kind === 'curated' && pack.version === undefined)
  if (versionTaken && resolved.gameVersion !== own && resolved.gameVersion !== facts.playsOn)
    throw new AppError(
      'invalid_choice',
      `No version of ${resolved.from} runs Minecraft ${own}, which this world was played on. Choose the version it was played with, or one on a newer Minecraft to update the world to.`,
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
