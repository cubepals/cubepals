// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An uploaded jar read for what it says about itself (§15.2): the loader metadata it declares,
 * held to running on a server. Not for the upload's two halves (`service.ts`), its malware check
 * (`jar-checks.ts`), or datapacks (`datapack-uploads.ts`).
 */
import { serverEnvironment } from '../../minecraft/mods.ts'
import {
  JAR_MANIFEST,
  JAR_METADATA,
  type JarMetadataFile,
  type ModMetadata,
  modMetadata,
} from '../../minecraft/uploads.ts'
import { AppError } from '../errors.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'

/**
 * What a jar says about itself, or why a server can't run it. One the catalog publishes is judged
 * by where the catalog says it runs, which is right more often than the jar's own word
 * (docs/modpack-system.md § Sides). An outage leaves the jar's.
 */
export async function readUploadedJar(
  deps: { formats: FileFormats; catalog: ModCatalog },
  bytes: Uint8Array,
  sha512: string,
): Promise<ModMetadata> {
  const names = [...(Object.keys(JAR_METADATA) as JarMetadataFile[]), JAR_MANIFEST]
  let files: Record<string, string>
  try {
    files = deps.formats.unzip(bytes, names)
  } catch (error) {
    if (error instanceof UnreadableFile) throw new AppError('invalid_upload', 'This file isn’t a whole jar.')
    throw error
  }
  const decoded: Partial<Record<JarMetadataFile, unknown>> = {}
  for (const [name, format] of Object.entries(JAR_METADATA) as Array<
    [JarMetadataFile, (typeof JAR_METADATA)[JarMetadataFile]]
  >) {
    const text = files[name]
    if (text === undefined) continue
    try {
      decoded[name] = deps.formats.decode(format, text)
    } catch (error) {
      if (error instanceof UnreadableFile)
        throw new AppError('invalid_upload', `The jar’s ${name} can’t be read: ${error.message}`)
      throw error
    }
  }
  const metadata = modMetadata(decoded, files[JAR_MANIFEST])
  if (metadata === null)
    throw new AppError(
      'invalid_upload',
      'This jar isn’t a mod or plugin Cubepals can read: it has no fabric.mod.json, mods.toml or plugin.yml.',
    )
  const published = (await deps.catalog.filesByHash([sha512]).catch(() => null))?.get(sha512)
  if (
    metadata.environment === 'client' ||
    (published !== undefined &&
      published.version.environment !== 'unknown' &&
      serverEnvironment(published.version.environment) === null)
  )
    throw new AppError('invalid_upload', `${metadata.name} only runs in players’ games, not on a server.`)
  return metadata
}
