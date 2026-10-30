// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server moved up to the Minecraft a world it restores was last played on, as its owner chose
 * when restoring a world they brought (`BackupService.restoreBackup`): the server as it is, on that
 * release, with its server type's build for it. Only a server without mods or a pack moves here;
 * one with them changes version in its settings, where its mods are resolved again. Not where a
 * version change is made otherwise (`RevisionService.changeVersion`).
 */
import { type RevisionDraft, runsOnPaper, type ServerRevision } from '../../domain/revision/revision.ts'
import { compareVersions, notOffered, supports } from '../../minecraft/versions.ts'
import { AppError } from '../errors.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { loaderPin, paperPin } from '../revisions/pins.ts'
import { draftOf } from '../revisions/service.ts'

export async function movedUp(
  builds: LoaderBuilds,
  desired: ServerRevision,
  gameVersion: string,
): Promise<RevisionDraft> {
  if (desired.modpack !== null || desired.mods.length > 0)
    throw new AppError(
      'invalid_choice',
      `This server has mods, which have to move to Minecraft ${gameVersion} with it. Change its version in Settings, then restore the world.`,
    )
  if (!supports(gameVersion, desired.loader))
    throw new AppError('invalid_choice', notOffered(desired.loader, gameVersion))
  const loaderVersion =
    desired.loader === 'vanilla'
      ? runsOnPaper(desired)
        ? await paperPin(builds, gameVersion, 'refuse')
        : null
      : await loaderPin(builds, desired.loader, gameVersion)
  return {
    ...draftOf(desired),
    gameVersion,
    loaderVersion,
    reason: 'version_changed',
    basedOnRevisionId: desired.id,
  }
}

/**
 * The release a restore moves its server up to: a world brought in from a newer Minecraft than the
 * server has, where its owner chose to move up. Null where the world opens as the server is; a
 * newer one its owner didn't choose to move up for is refused.
 */
export function movesUpTo(
  facts: { gameVersion: string } | null,
  serverVersion: string,
  moveUp: boolean | undefined,
): string | null {
  if (facts === null || compareVersions(facts.gameVersion, serverVersion) <= 0) return null
  if (moveUp) return facts.gameVersion
  throw new AppError(
    'version_downgrade',
    `This world was last played on Minecraft ${facts.gameVersion}, newer than this server's ${serverVersion}. Restore it moving the server up to ${facts.gameVersion}.`,
  )
}
