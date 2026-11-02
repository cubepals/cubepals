// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Expected server files after the shared pack inclusion policy, for both checks and actual starts. */
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { packCheck } from '../../minecraft/install-check.ts'
import type { PackContentsRecord } from './persistence.ts'

export function packInstallCheck(contents: PackContentsRecord, pack: NonNullable<ServerRevision['modpack']>) {
  const leftOut = new Set(pack.leaveOut ?? [])
  const needed = contents.leftOut.flatMap((entry) =>
    entry.why === 'needed' && entry.sha512 !== undefined ? [{ path: entry.path, sha512: entry.sha512 }] : [],
  )
  return packCheck(
    [...contents.jars, ...(contents.otherJars ?? []), ...needed].filter((jar) => !leftOut.has(jar.path)),
  )
}
