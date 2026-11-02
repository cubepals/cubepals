// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each catalog version's jar asks of a server (`minecraft/class-files.ts`): its Java, the
 * plugin an add-on loads on, the mods a Fabric mod needs. Read by byte ranges when resolution first
 * weighs the version, and kept with it: a version's jar never changes. A jar that can't be read (a host that doesn't answer ranges, a file that isn't a zip)
 * is unknown, held to nothing, and read again next time; its first boot tells the rest.
 *
 * It doesn't decide which Java a server runs (`minecraft/versions.ts`), nor whether a version
 * fits (`domain/mods/resolve.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { and, eq, inArray } from 'drizzle-orm'
import { type CatalogVersion, catalogOfId } from '../../domain/mods/catalog.ts'
import type { JarNeeds } from '../../domain/mods/jar-holds.ts'
import {
  addonNeeds,
  classesToRead,
  ENTRY_FILES,
  type EntryFile,
  fabricModOf,
  javaOfClasses,
} from '../../minecraft/class-files.ts'
import { loaderMetadata } from '../../minecraft/loader-metadata.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'

const needs = schema.catalogVersionNeeds

/** Entry files are a few kilobytes; a class past this is not one a loader starts from. */
const MAX_ENTRY_BYTES = 1024 * 1024
const MAX_CLASS_BYTES = 4 * 1024 * 1024

/** BentoBox, which loads the add-ons that name it in addon.yml, by its id in each catalog. */
const ADDON_HOST: Readonly<Record<string, string>> = { modrinth: 'aBVLHiAW' }

export class JarNeedsReader {
  readonly #db: Db
  readonly #formats: FileFormats
  /** Jars being read now, by version, so a resolution asking twice reads once. */
  readonly #reading = new Map<string, Promise<JarNeeds | null>>()

  constructor(deps: { db: Db; formats: FileFormats }) {
    this.#db = deps.db
    this.#formats = deps.formats
  }

  /** What these versions' jars ask for, by version id; null where a jar couldn't be read. */
  async of(catalog: string, versions: readonly CatalogVersion[]): Promise<Map<string, JarNeeds | null>> {
    const ids = versions.map((version) => version.versionId)
    const known =
      ids.length === 0
        ? []
        : await this.#db
            .select()
            .from(needs)
            .where(and(eq(needs.catalog, catalog), inArray(needs.versionId, ids)))
    // A row kept before a Fabric mod's own needs were read has its jar read again, once.
    const found = new Map<string, JarNeeds | null>(
      known.flatMap((row) =>
        row.modIds === null ||
        row.nativeMetadata === null ||
        row.fileSha512 !== versions.find((version) => version.versionId === row.versionId)?.file.sha512
          ? []
          : [
              [
                row.versionId,
                {
                  java: row.java,
                  native: row.nativeMetadata,
                  api:
                    row.apiProjectId === null || row.apiAtLeast === null
                      ? null
                      : { projectId: row.apiProjectId, atLeast: row.apiAtLeast },
                  mod:
                    row.modIds.length === 0
                      ? null
                      : {
                          ids: row.modIds,
                          depends: row.modDepends ?? [],
                          carriesJars: row.carriesJars ?? false,
                        },
                },
              ],
            ],
      ),
    )
    await Promise.all(
      versions
        .filter((version) => !found.has(version.versionId))
        .map(async (version) => found.set(version.versionId, await this.#once(catalog, version))),
    )
    return found
  }

  #once(catalog: string, version: CatalogVersion): Promise<JarNeeds | null> {
    const key = `${catalog}:${version.versionId}:${version.file.sha512}`
    const known = this.#reading.get(key)
    if (known !== undefined) return known
    const reading = this.#read(catalog, version).finally(() => this.#reading.delete(key))
    this.#reading.set(key, reading)
    return reading
  }

  async #read(catalog: string, version: CatalogVersion): Promise<JarNeeds | null> {
    // A Hangar plugin's add-ons would name its Hangar id: the catalog is the version's own.
    const source = catalogOfId(version.projectId, catalog)
    const read = await this.#readJar(source, version.file.url).catch((error: unknown) => {
      if (error instanceof UnreadableFile) return null
      throw error
    })
    if (read !== null) {
      const row = {
        java: read.java,
        apiProjectId: read.api?.projectId ?? null,
        apiAtLeast: read.api?.atLeast ?? null,
        modIds: read.mod?.ids ?? [],
        modDepends: read.mod?.depends ?? [],
        carriesJars: read.mod?.carriesJars ?? false,
        fileSha512: version.file.sha512,
        nativeMetadata: read.native ?? {},
        readAt: new Date(),
      }
      await this.#db
        .insert(needs)
        .values({ catalog, versionId: version.versionId, ...row })
        .onConflictDoUpdate({ target: [needs.catalog, needs.versionId], set: row })
    }
    return read
  }

  /** Two reads by ranges: the jar's directory with its entry files, then the classes they name. */
  async #readJar(catalog: string, url: string): Promise<JarNeeds> {
    const { api, mod, native, classes } = await this.#entryFiles(catalog, url)
    if (classes.size === 0) return { java: null, api, mod, native }
    const second = await this.#formats.readRemoteZip(url, {
      wanted: (name) => classes.has(name),
      maxEntryBytes: MAX_CLASS_BYTES,
    })
    return { java: javaOfClasses(second.entries.values()), api, mod, native }
  }

  /**
   * What the entry files say, and the few classes to read next. The jar's names, tens of thousands
   * in a big mod, are let go here rather than held while the classes wait their turn to be read.
   */
  async #entryFiles(
    catalog: string,
    url: string,
  ): Promise<Pick<JarNeeds, 'api' | 'mod' | 'native'> & { classes: Set<string> }> {
    const entries = new Set<string>(Object.keys(ENTRY_FILES))
    const first = await this.#formats.readRemoteZip(url, {
      wanted: (name) => entries.has(name),
      maxEntryBytes: MAX_ENTRY_BYTES,
    })
    const decoded: Partial<Record<EntryFile, unknown>> = {}
    let manifest: string | undefined
    for (const [name, bytes] of first.entries) {
      const file = name as EntryFile
      const format = ENTRY_FILES[file]
      const text = new TextDecoder().decode(bytes)
      if (format === 'manifest') manifest = text
      else
        try {
          decoded[file] = this.#formats.decode(format, text)
        } catch {
          // An entry file that doesn't parse names nothing; the sampled classes stand in.
        }
    }
    const host = ADDON_HOST[catalog]
    const addon = addonNeeds(decoded)
    const api = host === undefined || addon === null ? null : { projectId: host, atLeast: addon }
    return {
      api,
      mod: fabricModOf(decoded),
      native: loaderMetadata(decoded, first.names),
      classes: new Set(classesToRead(first.names, decoded, manifest)),
    }
  }
}
