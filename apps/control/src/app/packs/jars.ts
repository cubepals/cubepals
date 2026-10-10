// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import {
  JAR_MANIFEST,
  JAR_METADATA,
  type JarMetadataFile,
  type ModMetadata,
  modMetadata,
} from '../../minecraft/uploads.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'

/**
 * What a jar inside a pack says about itself, or null when it says nothing a loader reads or
 * can't be read: a pack's jar is evidence, never a reason to refuse the pack by itself.
 */
export function jarMetadata(formats: FileFormats, bytes: Uint8Array): ModMetadata | null {
  const names = [...(Object.keys(JAR_METADATA) as JarMetadataFile[]), JAR_MANIFEST]
  try {
    const files = formats.unzip(bytes, names)
    const decoded: Partial<Record<JarMetadataFile, unknown>> = {}
    for (const [name, format] of Object.entries(JAR_METADATA) as Array<
      [JarMetadataFile, (typeof JAR_METADATA)[JarMetadataFile]]
    >) {
      const text = files[name]
      if (text !== undefined) decoded[name] = formats.decode(format, text)
    }
    return modMetadata(decoded, files[JAR_MANIFEST])
  } catch (error) {
    if (error instanceof UnreadableFile) return null
    throw error
  }
}
