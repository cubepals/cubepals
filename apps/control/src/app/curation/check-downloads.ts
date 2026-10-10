// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every file a server installs, fetched from where its pack says and matched to the hash the pack
 * gives it: the same rule for a catalog pack's release and for one of Blockly's own.
 *
 * It doesn't fetch the pack itself, which only a catalog pack has (`catalog-check.ts`), and it
 * doesn't keep anything past the work directory: what a check keeps, ingestion writes.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackFile } from '../../minecraft/mrpack.ts'
import { PACK_LIMITS } from '../packs/build.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { PackArchives } from '../ports/formats.ts'
import { Refused, refusedDownload } from './check-outcome.ts'

/**
 * Every file a server installs, fetched from where its pack says and matched to the hash the
 * pack gives it. Kept on this machine only when Blockly will keep a copy of the pack.
 */
export async function fetchEach(
  deps: { archives: Pick<PackArchives, 'fetchTo'>; catalog: Pick<ModCatalog, 'packDownloadAllowed'> },
  ref: string,
  installed: readonly PackFile[],
  work: string,
  keep: boolean,
): Promise<{ kept: Map<string, string>; bytes: number; hosts: Set<string> }> {
  const allowed = (url: string) => deps.catalog.packDownloadAllowed(url)
  const kept = new Map<string, string>()
  const hosts = new Set<string>()
  let bytes = 0
  for (const [at, file] of installed.entries()) {
    const url = file.downloads[0] ?? ''
    if (!allowed(url))
      throw new Refused(
        `It downloads ${lastSegment(file.path)} from a site Cubepals doesn’t fetch packs from.`,
        `${ref}: ${url}`,
      )
    const to = join(work, `file-${at}`)
    const got = await deps.archives
      .fetchTo(url, to, file.sizeBytes > 0 ? file.sizeBytes : PACK_LIMITS.maxFileBytes, { allowed })
      .catch(refusedDownload(lastSegment(file.path)))
    if (got.sha512 !== file.sha512)
      throw new Refused(
        `${lastSegment(file.path)} isn’t what the pack says it is.`,
        `${ref}: ${url} served ${got.sha512}, the pack says ${file.sha512}`,
      )
    bytes += got.sizeBytes
    hosts.add(new URL(url).hostname)
    if (keep) kept.set(file.path, to)
    else await rm(to, { force: true })
  }
  return { kept, bytes, hosts }
}

const lastSegment = (path: string) => path.split('/').pop() || path
