// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server moved up to the Minecraft a world it restores was last played on, as its owner chose
 * when restoring a world they brought (`BackupService.restoreBackup`): the server as it is, on that
 * release, with its server type's build for it. Only a server without mods or a pack moves here
 * (`movesWithWorld`); one with them changes version in its settings, where its mods are resolved
 * again. Not where a version change is made otherwise (`RevisionService.changeVersion`).
 */
import type { BackupView } from '@blockly/contracts'
import { type RevisionDraft, runsOnPaper, type ServerRevision } from '../../domain/revision/revision.ts'
import { compareVersions, isRelease, notOffered, supports } from '../../minecraft/versions.ts'
import { AppError } from '../errors.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { loaderPin, paperPin } from '../revisions/pins.ts'
import { draftOf } from '../revisions/service.ts'

/** Whether a server moves up with a world it restores: one with mods or a pack changes version in its settings, where its mods are resolved again. */
export const movesWithWorld = (desired: Pick<ServerRevision, 'mods' | 'modpack'>): boolean =>
  desired.modpack === null && desired.mods.length === 0

/** The release a world was last played on where it is newer than the server's; null otherwise, a snapshot's included, whose name orders against no release. */
export const newerRelease = (played: string, serverVersion: string): string | null =>
  isRelease(played) && compareVersions(played, serverVersion) > 0 ? played : null

/** A brought world from a newer release than the server's, and whether playing it moves the server up; null otherwise. */
export function newerWorldOf(
  facts: { gameVersion: string } | null,
  serverVersion: string,
  movesServer: boolean,
): BackupView['newerWorld'] {
  const newer = facts === null ? null : newerRelease(facts.gameVersion, serverVersion)
  return newer === null ? null : { gameVersion: newer, movesServer }
}

/** The server on the release a world it restores was last played on, with its server type's build for it. */
export async function movedUp(
  builds: LoaderBuilds,
  desired: ServerRevision,
  gameVersion: string,
): Promise<RevisionDraft> {
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
 * server has, where its owner chose to move up and the server moves with it. Null where the world
 * opens as the server is. A newer one is refused otherwise, saying what to do.
 */
export function movesUpTo(
  facts: { gameVersion: string } | null,
  desired: Pick<ServerRevision, 'gameVersion' | 'mods' | 'modpack'>,
  moveUp: boolean | undefined,
): string | null {
  const newer = facts === null ? null : newerRelease(facts.gameVersion, desired.gameVersion)
  if (newer === null) return null
  const was = `This world was last played on Minecraft ${newer}, newer than this server's ${desired.gameVersion}.`
  if (!movesWithWorld(desired))
    throw new AppError(
      'version_downgrade',
      `${was} Change the server to ${newer} in Settings, so its mods move with it, then restore the world.`,
    )
  if (moveUp) return newer
  throw new AppError('version_downgrade', `${was} Restore it moving the server up to ${newer}.`)
}
