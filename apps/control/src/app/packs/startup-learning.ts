// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Runtime evidence refines a pack through its existing checked, reversible inclusion policy. */
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { Diagnosis } from '../../minecraft/diagnosis.ts'
import type { PackContents } from './contents.ts'

export async function learnPack(
  contents: Pick<PackContents, 'leaveOutAfterCrash' | 'keepAfterCrash'>,
  pack: NonNullable<ServerRevision['modpack']>,
  found: Diagnosis,
): Promise<boolean> {
  if (found.playersOnly !== undefined)
    return (await contents.leaveOutAfterCrash(pack.artifact.sha512, found.playersOnly)).length > 0
  if (found.missing === undefined) return false
  return (
    (await contents.keepAfterCrash(
      pack.artifact.sha512,
      found.missing,
      pack.artifact.ref.kind === 'remote' ? pack.artifact.ref.url : null,
    )) !== null
  )
}
