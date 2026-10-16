// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An owner's own datapack, checked as hostile input before anything of it is kept (§15.2): the zip
 * opened within fixed limits, its files held to what a datapack holds, its `pack.mcmeta` read, and
 * its formats held to the server's release. What passes is kept under its hash like an uploaded
 * jar: as it arrived, or made again from the files a server keeps when it came wrapped in a folder
 * or with resource-pack files.
 *
 * Not for: the upload's two halves and its record (`service.ts`, `uploads.ts`), or what the files
 * mean to Minecraft (`minecraft/datapack-files.ts`).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DatapackMetadata,
  datapackFits,
  datapackLayout,
  datapackTitle,
  madeFor,
  PACK_META,
  packMeta,
  packRoot,
  releasesFor,
} from '../../minecraft/datapack-files.ts'
import { AppError } from '../errors.ts'
import {
  type ArchiveLimits,
  type FileFormats,
  HostileArchive,
  type HostileReason,
  type PackArchive,
  type PackArchives,
  UnreadableFile,
} from '../ports/formats.ts'
import type { ArchiveStore } from '../ports/optional.ts'

/**
 * Every limit on an uploaded datapack, in one place. The largest minigame and world-generation
 * datapacks hold a few thousand small files; these leave them room many times over.
 */
export const DATAPACK_LIMITS = {
  /** The zip as uploaded. */
  maxUploadBytes: 64 * 1024 * 1024,
  /** The zip's files, and their sizes once unpacked: each, and all together. */
  archive: { maxFiles: 20_000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 },
  /** `pack.mcmeta` is a few lines of JSON. */
  maxMetaBytes: 64 * 1024,
} as const satisfies { archive: ArchiveLimits } & Record<string, unknown>

/** A zip the archive reader won't open, in one sentence each. */
const UNSAFE: Record<HostileReason, string> = {
  unsafe_name: 'This zip names a file outside itself, so Cubepals won’t open it.',
  link: 'This zip holds a link, and a datapack holds only files.',
  encrypted: 'This zip is locked with a password. Upload it unlocked.',
  duplicate: 'This zip holds the same file twice.',
  too_many_files: `A datapack can hold up to ${DATAPACK_LIMITS.archive.maxFiles.toLocaleString('en-US')} files.`,
  too_large: 'Unpacked, this zip is bigger than any datapack.',
  bomb: 'This zip unpacks to far more than it holds, so Cubepals won’t open it.',
  malformed: 'This zip is damaged. Make it again and upload it.',
}

/** What the server keeps of an upload: its bytes in the store, and what it says about itself. */
export interface KeptDatapack {
  sha512: string
  key: string
  sizeBytes: number
  metadata: DatapackMetadata
}

export class DatapackUploads {
  readonly #archives: PackArchives
  readonly #formats: FileFormats

  constructor(deps: { archives: PackArchives; formats: FileFormats }) {
    this.#archives = deps.archives
    this.#formats = deps.formats
  }

  /**
   * The upload checked and kept. `url` serves the bytes as they arrived, which are `bytes`;
   * `gameVersion` is the release the server runs. A refusal is an `invalid_upload` in one sentence.
   */
  async keep(
    store: ArchiveStore,
    upload: { url: string; bytes: Uint8Array; sha512: string; fileName: string; gameVersion: string },
  ): Promise<KeptDatapack> {
    const work = await mkdtemp(join(tmpdir(), 'blockly-datapack-'))
    try {
      const path = join(work, 'upload.zip')
      await writeFile(path, upload.bytes)
      const archive = await this.#archives.open(path, DATAPACK_LIMITS.archive).catch(refusing)
      try {
        const { metadata, layout } = await this.#read(archive, upload.fileName)
        if (!datapackFits(metadata.formats, upload.gameVersion)) {
          const made = madeFor(releasesFor(metadata.formats))
          throw new AppError(
            'invalid_upload',
            made === null
              ? `It was made for a Minecraft newer than Cubepals knows, and this server runs ${upload.gameVersion}.`
              : `It was made for Minecraft ${made}, and this server runs ${upload.gameVersion}.`,
          )
        }
        if (!layout.repack) {
          const key = await store.ingestFromUrl(upload.url, upload.sha512)
          return { sha512: upload.sha512, key, sizeBytes: upload.bytes.length, metadata }
        }
        const out = join(work, 'datapack.zip')
        const written = await this.#archives.write(out, kept(archive, layout.root, layout.kept))
        const key = await store.ingestFile(out, written.sha512)
        return { sha512: written.sha512, key, sizeBytes: written.sizeBytes, metadata }
      } finally {
        await archive.close()
      }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  async #read(archive: PackArchive, fileName: string) {
    const names = archive.files.map((file) => file.name)
    const root = packRoot(names)
    if (root === null)
      throw new AppError('invalid_upload', 'This isn’t a datapack: it has no pack.mcmeta at its top.')
    const bytes = await archive.read(`${root}${PACK_META}`, DATAPACK_LIMITS.maxMetaBytes).catch(refusing)
    let decoded: unknown
    try {
      decoded = this.#formats.decode('json', new TextDecoder().decode(bytes).replace(/^﻿/, ''))
    } catch (error) {
      if (error instanceof UnreadableFile)
        throw new AppError('invalid_upload', 'Its pack.mcmeta can’t be read as JSON.')
      throw error
    }
    const meta = packMeta(decoded)
    if (meta.kind === 'refused') throw new AppError('invalid_upload', meta.message)
    const layout = datapackLayout(names, root, meta.overlays)
    if (layout.kind === 'refused') throw new AppError('invalid_upload', layout.message)
    const metadata: DatapackMetadata = {
      format: 'pack.mcmeta',
      name: datapackTitle(meta.description, fileName),
      formats: meta.formats,
      leftOut: layout.leftOut,
    }
    return { metadata, layout }
  }
}

/** The files a server keeps, at the zip's top. */
async function* kept(archive: PackArchive, root: string, names: readonly string[]) {
  for (const name of names) yield { name: name.slice(root.length), data: archive.stream(name) }
}

/** A zip the reader refused, said in one sentence; anything else goes on as it was. */
function refusing(error: unknown): never {
  if (error instanceof HostileArchive) throw new AppError('invalid_upload', UNSAFE[error.reason])
  if (error instanceof UnreadableFile) throw new AppError('invalid_upload', 'This file isn’t a whole zip.')
  throw error
}
