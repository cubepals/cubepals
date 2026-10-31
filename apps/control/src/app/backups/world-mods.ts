// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The mods a brought world was played with (docs/world-import.md § Mods), from what its upload
 * holds beside it: a launcher's instance around it, or a mods folder sent with it
 * (`minecraft/instance-layout.ts`). The loader comes from the instance's components, read as a
 * pack's are (`instanceIdentity`), else from the world's `ServerBrands`, else from what its jars
 * are for (`runsOn`). Each jar is matched to Modrinth (`mods/jar-matches.ts`); one only players'
 * games run is left out and named; one no catalog has is kept as its owner's upload after an
 * upload's checks (`mods/own-jars.ts`). What is found is kept with the world's backup, and shown to
 * its owner as `playedWith` (`playedWithOf`), for the restore that brings them (`restored-mods.ts`).
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlayedWith } from '@blockly/contracts'
import type { BroughtModsJson, UploadedWorldFactsJson } from '@blockly/db'
import { playedWithIn } from '../../minecraft/instance-layout.ts'
import { PACK_LOADERS, type PackLoader } from '../../minecraft/mrpack.ts'
import { namedReleases, runsOn } from '../../minecraft/pack-build.ts'
import { instanceIdentity, packwizMod } from '../../minecraft/pack-manifests.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { moddedBrands } from '../../minecraft/world-facts.ts'
import { type BroughtJar, type JarMatch, matchJars } from '../mods/jar-matches.ts'
import type { OwnJars } from '../mods/own-jars.ts'
import { MAX_JAR_BYTES } from '../mods/service.ts'
import { jarMetadata } from '../packs/jars.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { FileFormats } from '../ports/formats.ts'
import type { Read } from './world-reading.ts'

/** How many jars of a mods folder are read: more than the largest packs hold. */
const MOST_JARS = 500

/** A jar read from the upload, where it was written on this machine. */
type ReadJar = BroughtJar & { path: string }

export class WorldMods {
  readonly #formats: FileFormats
  readonly #catalog: Pick<ModCatalog, 'versionsByIds' | 'filesByHash'>
  readonly #own: Pick<OwnJars, 'mayKeep' | 'keep'>

  constructor(deps: {
    formats: FileFormats
    catalog: Pick<ModCatalog, 'versionsByIds' | 'filesByHash'>
    ownJars: Pick<OwnJars, 'mayKeep' | 'keep'>
  }) {
    this.#formats = deps.formats
    this.#catalog = deps.catalog
    this.#own = deps.ownJars
  }

  /**
   * The mods beside the world `read` found, for `ownerId`, each jar read into `work`: matched, its
   * owner's own kept as their uploads, and those left out with why. Null where it holds none, or
   * none whose loader can be told.
   */
  async found(read: Read, ownerId: string, work: string): Promise<BroughtModsJson | null> {
    const files = playedWithIn(
      read.archive.files.map((file) => file.name),
      read.world,
    )
    if (files.jars.length === 0) return null
    const { jars, tooLarge } = await this.#jars(read, files.jars, work)
    const loader = this.#loader(read, files, jars)
    if (loader === null) return null
    const sources = files.sources.flatMap((path) => {
      const mod = this.#decoded(read, path, (text) => packwizMod(this.#formats.decode('toml', text)))
      return mod === null ? [] : [mod]
    })
    const found: BroughtModsJson = { loader, catalog: [], own: [], forPlayers: [], refused: [] }
    const unread = (paths: readonly string[], why: string) =>
      found.refused.push(...paths.map((path) => ({ name: nameOf(path), fileName: nameOf(path), why })))
    // Past the first, one entry for them all: an upload may hold any number.
    const past = files.jars.slice(MOST_JARS)
    const first = past[0]
    if (first !== undefined)
      found.refused.push({
        name: `${past.length} more ${past.length === 1 ? 'mod' : 'mods'}`,
        fileName: nameOf(first),
        why: `Cubepals reads the first ${MOST_JARS} mods of a world.`,
      })
    unread(tooLarge, `It is larger than the ${MAX_JAR_BYTES / 1024 ** 2} MB a mod can be.`)
    await this.#sort(await matchJars(this.#catalog, jars, sources), jars, ownerId, found)
    return found
  }

  /** Each match put where it goes: on the catalog, its owner's own, or left out. */
  async #sort(
    matches: readonly JarMatch[],
    jars: readonly ReadJar[],
    ownerId: string,
    found: BroughtModsJson,
  ): Promise<void> {
    const own = matches.filter((match) => match.kind === 'own' && !match.forPlayers)
    const refusal = own.length === 0 ? null : await this.#own.mayKeep(ownerId)
    for (const match of matches) {
      const mod = { name: match.name, fileName: match.jar.fileName }
      if (match.forPlayers) found.forPlayers.push(mod)
      else if (match.kind === 'catalog')
        found.catalog.push({ ...mod, projectId: match.version.projectId, versionId: match.version.versionId })
      else if (refusal !== null) found.refused.push({ ...mod, why: refusal })
      else {
        const path = jars.find((jar) => jar === match.jar)?.path ?? ''
        const kept = await this.#own.keep(ownerId, { path, fileName: match.jar.fileName })
        if ('uploadId' in kept) found.own.push({ ...mod, uploadId: kept.uploadId })
        else found.refused.push({ ...mod, why: kept.refused })
      }
    }
  }

  /** The jars at `paths`, read in one pass of the upload: hashed, read for what each says, and written to `work`. */
  async #jars(
    read: Read,
    paths: readonly string[],
    work: string,
  ): Promise<{ jars: ReadJar[]; tooLarge: string[] }> {
    const wanted = new Set(paths.slice(0, MOST_JARS))
    const dir = join(work, 'mods')
    await mkdir(dir, { recursive: true })
    const jars: ReadJar[] = []
    const tooLarge: string[] = []
    for await (const file of read.archive.entries()) {
      const large = file.sizeBytes > MAX_JAR_BYTES
      if (!wanted.has(file.name) || large) {
        if (large && wanted.delete(file.name)) tooLarge.push(file.name)
        await file.data.cancel()
        if (wanted.size === 0) break
        continue
      }
      wanted.delete(file.name)
      const bytes = new Uint8Array(await new Response(file.data).arrayBuffer())
      const path = join(dir, `${jars.length}.jar`)
      await writeFile(path, bytes)
      jars.push({
        path,
        fileName: nameOf(file.name),
        sha1: createHash('sha1').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('hex'),
        metadata: jarMetadata(this.#formats, bytes),
      })
      // Mods come before saves in an instance's folder: the rest of the world needn't be read again.
      if (wanted.size === 0) break
    }
    return { jars, tooLarge }
  }

  /** The loader the world was played on: its instance's, its level.dat's, or the one its jars are for. */
  #loader(read: Read, files: ReturnType<typeof playedWithIn>, jars: readonly ReadJar[]): PackLoader | null {
    const isLoader = (name: string | null | undefined): name is PackLoader =>
      name !== null && name !== undefined && Object.hasOwn(PACK_LOADERS, name)
    if (files.components !== null) {
      const cfg = files.settings === null ? undefined : this.#text(read, files.settings)
      const identity = this.#decoded(read, files.components, (text) =>
        instanceIdentity(this.#formats.decode('json', text), cfg ?? undefined),
      )
      if (isLoader(identity?.loader)) return identity.loader
    }
    const branded = moddedBrands(read.facts).find(isLoader)
    if (branded !== undefined) return branded
    const mods = jars.flatMap((jar) => (jar.metadata === null ? [] : [jar.metadata]))
    const inferred = runsOn(mods, [...offeredVersions().map((v) => v.id), ...namedReleases(mods)])
    return 'refused' in inferred ? null : inferred.loader
  }

  #text(read: Read, path: string): string | null {
    const raw = read.archive.kept.get(path)
    return raw === undefined ? null : new TextDecoder().decode(raw)
  }

  /** A small file of the upload, decoded; null where it is missing or can't be read. */
  #decoded<T>(read: Read, path: string, decode: (text: string) => T): T | null {
    const text = this.#text(read, path)
    if (text === null) return null
    try {
      return decode(text)
    } catch {
      return null
    }
  }
}

/** A path's file name. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** A brought world's mods as its owner sees them, from what its backup keeps of them. */
export function playedWithOf(facts: UploadedWorldFactsJson | null): PlayedWith {
  if (facts === null || (facts.mods === undefined && (facts.moddedWith ?? []).length === 0)) return null
  const { mods } = facts
  return {
    moddedWith: facts.moddedWith ?? [],
    mods:
      mods === undefined
        ? null
        : {
            loader: mods.loader,
            mods: [
              ...mods.catalog.map(({ name, fileName }) => ({ name, fileName, from: 'modrinth' as const })),
              ...mods.own.map(({ name, fileName }) => ({ name, fileName, from: 'own' as const })),
            ],
            forPlayers: mods.forPlayers,
            leftOut: mods.refused,
          },
  }
}
