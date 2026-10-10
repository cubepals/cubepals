// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import type { Db, PackJarJson, PackLeftOutJson } from '@blockly/db'
import { INDEX_FILE, isJar, playersNeedIt, readIndex, serverFiles } from '../../minecraft/mrpack.ts'
import { jarNamed, jarSide } from '../../minecraft/pack-build.ts'
import { HAND_DOWNLOADS, handDownloads } from '../../minecraft/packs.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'
import { jarMetadata } from './jars.ts'
import {
  keepPackJar,
  leavePackJarOut,
  loadPackContents,
  type PackContentsRecord,
  savePackContents,
} from './persistence.ts'

/**
 * What a pack from the catalog holds, read from its file by byte ranges the first time anybody
 * picks that version and kept by the file's sha512 afterwards (docs/modpack-system.md): what it
 * runs on, as its own index says rather than the catalog's tags; the jars a server installs from
 * it; and which it leaves to players' games, by the catalog's record of each jar rather than the
 * pack's own marks, which are often wrong (COBBLEVERSE and Better MC mark every mod as needed on
 * the server).
 */

/** Jars a pack carries inside itself are read to be checked, up to this much of them in all. */
const CARRIED_JAR_BYTES = 256 * 1024 * 1024
const INDEX_BYTES = 16 * 1024 * 1024

export type CatalogPackContents =
  | { kind: 'read'; contents: PackContentsRecord; handDownloads: string[] }
  | { kind: 'refused'; message: string }

export class PackContents {
  readonly #db: Db
  readonly #formats: FileFormats
  readonly #catalog: ModCatalog
  /** Reads in flight, so two picks of one version read it once. */
  readonly #reading = new Map<string, Promise<CatalogPackContents>>()

  constructor(deps: { db: Db; formats: FileFormats; catalog: ModCatalog }) {
    this.#db = deps.db
    this.#formats = deps.formats
    this.#catalog = deps.catalog
  }

  /** What a pack file holds, from the database when it was read before. */
  load(sha512: string): Promise<PackContentsRecord | null> {
    return loadPackContents(this.#db, sha512)
  }

  /**
   * Mods that stopped a server of this pack as it started, being for players' games alone, each
   * named as its loader printed it (its name, and its id where printed): their jars are left out of
   * every server of the pack from now on, as the jars the catalog marks for players' games are. The
   * paths newly left out; none when no jar of the pack is one of them, or all were already out.
   */
  async leaveOutAfterCrash(
    sha512: string,
    mods: ReadonlyArray<{ name: string; id: string | null }>,
  ): Promise<string[]> {
    const pack = await loadPackContents(this.#db, sha512)
    if (pack === null) return []
    const out = new Set(pack.leftOut.map((l) => l.path))
    const candidates = pack.jars.map((jar) => jar.path).filter((p) => !out.has(p))
    const paths = new Set<string>()
    for (const mod of mods) {
      const path = (mod.id === null ? null : jarNamed(candidates, mod.id)) ?? jarNamed(candidates, mod.name)
      if (path !== null) paths.add(path)
    }
    const left: string[] = []
    for (const path of paths)
      if (await leavePackJarOut(this.#db, sha512, { path, why: 'crashed' })) left.push(path)
    return left
  }

  /**
   * A mod another mod of the pack needs, named by the id its loader printed, which Blockly left
   * out as being for players' games, or which the pack at `packUrl` keeps off servers itself: the
   * pack's servers run it after all. Never a mod that stopped a server itself. The jar's path, or
   * null.
   */
  async keepAfterCrash(sha512: string, mod: string, packUrl: string | null = null): Promise<string | null> {
    const pack = await loadPackContents(this.#db, sha512)
    if (pack === null) return null
    const path = jarNamed(
      pack.leftOut.filter((l) => l.why === 'players').map((l) => l.path),
      mod,
    )
    if (path !== null) return (await keepPackJar(this.#db, sha512, path)) ? path : null
    // Or the pack itself keeps it off servers (Cabricality 0.3.1 marks Equator so, which its own
    // mod needs): its servers install it anyway, from the pack's own index.
    if (packUrl === null) return null
    const read = await this.#formats.readRemoteZip(packUrl, {
      wanted: (name) => name === INDEX_FILE,
      maxEntryBytes: INDEX_BYTES,
    })
    const bytes = read.entries.get(INDEX_FILE)
    if (bytes === undefined) return null
    const index = readIndex(this.#formats.decode('json', new TextDecoder().decode(bytes)))
    if ('refused' in index) return null
    const known = new Set(pack.leftOut.map((l) => l.path))
    const offServers = index.files
      .filter((file) => file.env.server === 'unsupported' && isJar(file.path) && !known.has(file.path))
      .map((file) => file.path)
    const needed = jarNamed(offServers, mod)
    if (needed === null) return null
    return (await leavePackJarOut(this.#db, sha512, { path: needed, why: 'needed' })) ? needed : null
  }

  /** A catalog pack version's file, read once. */
  ofCatalog(file: { url: string; sha512: string }): Promise<CatalogPackContents> {
    const known = this.#reading.get(file.sha512)
    if (known !== undefined) return known
    const reading = this.#read(file).finally(() => this.#reading.delete(file.sha512))
    this.#reading.set(file.sha512, reading)
    return reading
  }

  async #read(file: { url: string; sha512: string }): Promise<CatalogPackContents> {
    const saved = await loadPackContents(this.#db, file.sha512)
    const first = await this.#formats.readRemoteZip(file.url, {
      wanted: (name) => name === INDEX_FILE || name === HAND_DOWNLOADS,
      maxEntryBytes: INDEX_BYTES,
    })
    const byHand = decodeList(this.#formats, first.entries.get(HAND_DOWNLOADS))
    if (saved !== null) return { kind: 'read', contents: saved, handDownloads: byHand }
    const indexBytes = first.entries.get(INDEX_FILE)
    if (indexBytes === undefined)
      return { kind: 'refused', message: 'This pack has no index, so Cubepals can’t read it.' }
    const index = readIndex(this.#formats.decode('json', new TextDecoder().decode(indexBytes)))
    if ('refused' in index) return { kind: 'refused', message: index.refused }
    if (index.loader === 'vanilla')
      return {
        kind: 'refused',
        message: 'This pack has no mod loader, so there’s nothing for a server to run.',
      }

    // The jars it carries inside itself, which its index doesn't list: Better MC 4 carries 21.
    const carried = first.names.filter((name) => /^(server-)?overrides\/mods\/[^/]+\.jar$/i.test(name))
    const carriedBytes =
      carried.length === 0 ? new Map<string, Uint8Array>() : await this.#carried(file.url, carried)
    const carriedJars = [...carriedBytes.entries()].map(([name, bytes]) => ({
      name,
      path: name.replace(/^(server-)?overrides\//, ''),
      sha512: createHash('sha512').update(bytes).digest('hex'),
      size: bytes.length,
      metadata: jarMetadata(this.#formats, bytes),
    }))

    const listed = serverFiles(index).filter((f) => isJar(f.path))
    const published = await this.#catalog.filesByHash([
      ...listed.map((f) => f.sha512),
      ...carriedJars.map((j) => j.sha512),
    ])
    const leftOut: PackLeftOutJson[] = []
    const jars: PackJarJson[] = []
    // A mod another kept mod needs stays, whatever it says about itself.
    const needed = new Set(
      [...published.values()].flatMap((m) =>
        m.version.dependencies
          .filter((d) => d.kind === 'required' && d.projectId)
          .map((d) => d.projectId as string),
      ),
    )
    for (const file of listed) {
      const match = published.get(file.sha512)
      const side = jarSide({ catalog: match?.version.environment ?? null })
      if (side === 'client' && !needed.has(match?.version.projectId ?? ''))
        leftOut.push({ path: file.path, why: 'players' })
      else jars.push({ path: file.path, sha512: file.sha512, sizeBytes: file.sizeBytes })
    }
    for (const jar of carriedJars) {
      const match = published.get(jar.sha512)
      const side = jarSide({ catalog: match?.version.environment ?? null, metadata: jar.metadata })
      if (side === 'client' && !needed.has(match?.version.projectId ?? ''))
        leftOut.push({ path: jar.name, why: 'players' })
      else jars.push({ path: jar.path, sha512: jar.sha512, sizeBytes: jar.size })
    }
    const contents: PackContentsRecord = {
      sha512: file.sha512,
      name: index.name,
      versionLabel: index.versionId,
      gameVersion: index.gameVersion,
      loader: index.loader,
      loaderVersion: index.loaderVersion,
      playersNeedIt: playersNeedIt(index),
      jars,
      leftOut,
      memoryMb: null,
    }
    await savePackContents(this.#db, contents)
    return { kind: 'read', contents, handDownloads: byHand }
  }

  /** The jars a pack carries, by ranges, while they add up to no more than it is worth reading. */
  async #carried(url: string, names: readonly string[]): Promise<Map<string, Uint8Array>> {
    const wanted = new Set(names)
    try {
      const read = await this.#formats.readRemoteZip(url, {
        wanted: (name) => wanted.has(name),
        maxEntryBytes: CARRIED_JAR_BYTES / 4,
      })
      let total = 0
      const kept = new Map<string, Uint8Array>()
      for (const [name, bytes] of read.entries) {
        total += bytes.length
        if (total > CARRIED_JAR_BYTES) break
        kept.set(name, bytes)
      }
      return kept
    } catch (error) {
      // A pack whose carried jars can't be read by ranges is installed as it is.
      if (error instanceof UnreadableFile) return new Map()
      throw error
    }
  }
}

function decodeList(formats: FileFormats, bytes: Uint8Array | undefined): string[] {
  if (bytes === undefined) return []
  try {
    return handDownloads(formats.decode('json', new TextDecoder().decode(bytes)))
  } catch {
    return []
  }
}
