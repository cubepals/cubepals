// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModArtifact } from '../domain/mods/artifact.ts'
import type { Loader } from '../domain/revision/revision.ts'

/** The volume's mount point inside the image. */
export const DATA_DIR = '/data'

/**
 * Where the image installs a loader's jars, and the variable that lists them: Paper takes
 * plugins, every mod loader takes mods, vanilla takes neither.
 */
export function jarsOf(loader: Loader): { dir: string; env: 'MODS' | 'PLUGINS' } | null {
  if (loader === 'vanilla') return null
  return loader === 'paper'
    ? { dir: `${DATA_DIR}/plugins`, env: 'PLUGINS' }
    : { dir: `${DATA_DIR}/mods`, env: 'MODS' }
}

/**
 * The name an artifact has on disk, and the last segment of its link: the image names a
 * download after the link, URL-decoded and without the query (mc-image-helper 1.68.0,
 * docs/dependency-audit.md). Unique per content, so the image's "already up to date" check can
 * never mistake one file for another published under the same name.
 */
export const diskName = (artifact: ModArtifact) => `${artifact.sha512.slice(0, 12)}-${artifact.fileName}`
