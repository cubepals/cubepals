// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server moved to the loader a world it restores was played on, with the mods it was played with
 * (docs/world-import.md § Mods), as its owner chose when restoring a world they brought with its
 * mods (`withMods`, `BackupService.restoreBackup`). The mods are resolved as any change of mods is
 * (`ModService.planOn`), the server's own with them: each brings what it depends on, and is held to
 * the release and the loader. Each from the catalog is the version it was played with where the
 * server runs the world's own release, else that mod's newest for the server's. A world from a
 * newer release moves the server up to it only where its owner chose that too (`moveUp`). Moving
 * loader isn't one-way: the snapshot the restore takes, and the revision before, are the way back.
 * Not where the mods are found (`world-mods.ts`), or a world moved up without them (`moved-up.ts`).
 */
import type { BroughtModsJson } from '@blockly/db'
import type { RevisionDraft, ServerRevision } from '../../domain/revision/revision.ts'
import { LOADER_LABELS, notOffered, supports } from '../../minecraft/versions.ts'
import { AppError } from '../errors.ts'
import type { ModService } from '../mods/service.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { loaderPin } from '../revisions/pins.ts'
import { draftOf } from '../revisions/service.ts'
import { newerRelease } from './moved-up.ts'

/** The revision a restore with a world's mods makes, and the one it was resolved from. */
export interface WithMods {
  draft: RevisionDraft
  basedOn: string
}

/**
 * The server on the loader `mods` were played on, with them, on the world's release where it is
 * newer and its owner chose to move up, else on the server's own. Refused, saying why, where they
 * can't run there.
 */
export async function withWorldMods(
  deps: { mods: Pick<ModService, 'planOn'>; builds: LoaderBuilds },
  desired: ServerRevision,
  world: { gameVersion: string; mods: BroughtModsJson },
  moveUp: boolean | undefined,
): Promise<WithMods> {
  const newer = newerRelease(world.gameVersion, desired.gameVersion)
  if (newer !== null && !moveUp)
    throw new AppError(
      'version_downgrade',
      `This world was last played on Minecraft ${newer}, newer than this server's ${desired.gameVersion}. Restore it moving the server up to ${newer}.`,
    )
  const gameVersion = newer ?? desired.gameVersion
  const { loader } = world.mods
  if (!supports(gameVersion, loader)) throw new AppError('invalid_choice', notOffered(loader, gameVersion))
  const exact = gameVersion === world.gameVersion
  const plan = await deps.mods.planOn(
    desired,
    { gameVersion, loader },
    {
      add: world.mods.catalog.map((mod) => ({
        projectId: mod.projectId,
        ...(exact ? { versionId: mod.versionId } : {}),
      })),
      addUploads: world.mods.own.map((mod) => mod.uploadId),
    },
  )
  if (plan.kind === 'conflicts')
    throw new AppError(
      'mods_conflict',
      `The mods this world was played with can’t run together on ${LOADER_LABELS[loader]} for Minecraft ${gameVersion}: ${plan.conflicts.map((c) => c.mod).join(', ')}.`,
    )
  const moves = gameVersion !== desired.gameVersion || loader !== desired.loader
  return {
    basedOn: plan.basedOn,
    draft: {
      ...draftOf(desired),
      gameVersion,
      loader,
      loaderVersion: await loaderPin(deps.builds, loader, gameVersion),
      mods: plan.mods,
      reason: moves ? 'version_changed' : 'mods_changed',
      basedOnRevisionId: desired.id,
    },
  }
}
