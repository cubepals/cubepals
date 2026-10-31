// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which published mod each jar someone brought is (a world's mods folder, docs/world-import.md §
 * Mods): first by the source its launcher recorded beside it (Prism's `.pw.toml`, packwiz's format,
 * `minecraft/pack-manifests.ts` `packwizMod`) where that names a catalog version whose file is these
 * very bytes, then by the jar's own sha512 (Modrinth's `version_files` lookup, `filesByHash`). A jar
 * neither finds is its owner's own. Each is given the side it runs on as a pack's jars are
 * (`jarSide`): the catalog's record of that exact file, else what the jar says of itself. Not where
 * an own jar is kept (`own-jars.ts`) or the mods are added to a server (`backups/restored-mods.ts`).
 */
import { jarSide } from '../../minecraft/pack-build.ts'
import type { PackwizMod } from '../../minecraft/pack-manifests.ts'
import type { ModMetadata } from '../../minecraft/uploads.ts'
import type { CatalogVersion, ModCatalog } from '../ports/catalog.ts'

/** A jar brought with something else, hashed and read for what it says of itself. */
export interface BroughtJar {
  /** Its file's name, as its folder had it. */
  fileName: string
  sha1: string
  sha512: string
  metadata: ModMetadata | null
}

/** What a jar is: an exact catalog version, or its owner's own; and whether a server runs it. */
export type JarMatch = {
  jar: BroughtJar
  /** What its owner calls it: its source's name, the jar's own, or its file's. */
  name: string
  /** Only players' games run it: it is left out of a server. */
  forPlayers: boolean
} & ({ kind: 'catalog'; version: CatalogVersion; by: 'source' | 'hash' } | { kind: 'own' })

/** Packwiz's hash formats a source names, by the digest of the jar each is (packwiz's `hash-format`). */
const DIGESTS = { sha512: 'sha512', sha1: 'sha1' } as const satisfies Record<string, keyof BroughtJar>

/**
 * The source recorded for a jar: the one of its file's name, where it says what the jar's bytes are
 * and they are these, or says nothing of them. One recorded for other bytes (the jar was replaced
 * since) says nothing of this jar.
 */
function sourceOf(jar: BroughtJar, sources: readonly PackwizMod[]): PackwizMod | null {
  const source = sources.find((one) => one.filename === jar.fileName)
  if (source === undefined) return null
  if (source.hash === null) return source
  const digest = DIGESTS[source.hash.format as keyof typeof DIGESTS]
  return digest !== undefined && jar[digest] === source.hash.value ? source : null
}

/** Each jar matched to the catalog, in the order given. */
export async function matchJars(
  catalog: Pick<ModCatalog, 'versionsByIds' | 'filesByHash'>,
  jars: readonly BroughtJar[],
  sources: readonly PackwizMod[],
): Promise<JarMatch[]> {
  const recorded = new Map(jars.map((jar) => [jar, sourceOf(jar, sources)]))
  // Only a source that vouches for the bytes names the catalog version they are.
  const vouched = (source: PackwizMod | null | undefined) => (source?.hash ? source.modrinth : null)
  const ids = [...recorded.values()].flatMap((source) => {
    const ids = vouched(source)
    return ids === null ? [] : [ids.versionId]
  })
  const versions = ids.length === 0 ? new Map<string, CatalogVersion>() : await catalog.versionsByIds(ids)
  // A recorded version whose file is another (the jar was replaced since) is found by its bytes.
  const bySource = new Map<BroughtJar, CatalogVersion>()
  for (const [jar, source] of recorded) {
    const ids = vouched(source)
    const version = ids === null ? undefined : versions.get(ids.versionId)
    if (version !== undefined && version.file.sha512 === jar.sha512) bySource.set(jar, version)
  }
  const rest = jars.filter((jar) => !bySource.has(jar)).map((jar) => jar.sha512)
  const published = rest.length === 0 ? new Map() : await catalog.filesByHash(rest)
  return jars.map((jar): JarMatch => {
    const source = recorded.get(jar) ?? null
    const name = source?.name ?? jar.metadata?.name ?? jar.fileName.replace(/\.jar$/i, '')
    const found = bySource.get(jar)
    const version = found ?? published.get(jar.sha512)?.version
    // One the catalog doesn't publish has only its own word, and its launcher's (`side`).
    if (version === undefined)
      return {
        jar,
        name,
        kind: 'own',
        forPlayers: source?.side === 'client' || jarSide({ metadata: jar.metadata }) === 'client',
      }
    const forPlayers = jarSide({ catalog: version.environment, metadata: jar.metadata }) === 'client'
    return { jar, name, kind: 'catalog', version, by: found ? 'source' : 'hash', forPlayers }
  })
}
