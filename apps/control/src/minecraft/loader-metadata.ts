// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The declarations inside a universal jar, separated by loader and server environment. Catalog
 * dependencies are useful discovery evidence; they cannot turn a NeoForge requirement into a
 * Fabric requirement. Unsupported declaration shapes remain incomplete and require runtime checking.
 */
import type { LoaderMod } from '../domain/mods/jar-holds.ts'
import { type EntryFile, fabricModOf } from './class-files.ts'
import { list, record, text } from './plain-data.ts'

export function loaderMetadata(
  decoded: Partial<Record<EntryFile, unknown>>,
  entries: readonly string[] = [],
): Record<string, LoaderMod> {
  const found: Record<string, LoaderMod> = {}
  const fabric = fabricModOf(decoded)
  if (fabric !== null) {
    const mod = record(decoded['fabric.mod.json'])
    const requirements = fabric.depends.map((id) => ({ id, versions: ranges(record(mod.depends)[id]) }))
    found.fabric = {
      ...fabric,
      version: text(mod.version) ?? null,
      environment: mod.environment === 'client' || mod.environment === 'server' ? mod.environment : 'both',
      complete: requirements.every((requirement) => requirement.versions.length > 0),
      requirements,
    }
  }
  for (const [loader, file] of Object.entries({
    forge: 'META-INF/mods.toml',
    neoforge: 'META-INF/neoforge.mods.toml',
  }) as Array<[string, EntryFile]>) {
    const metadata = forgeMetadata(decoded[file])
    if (metadata !== null) {
      // Jar-in-jar libraries can provide required ids absent from the outer declarations.
      // As with Fabric's nested jars, the actual loader must establish those dependencies.
      metadata.carriesJars = entries.some((name) => name.toLowerCase().endsWith('.jar'))
      found[loader] = metadata
    }
  }
  return found
}

/** TOML dependencies are scoped both to the declaring mod and to CLIENT, SERVER or BOTH. */
function forgeMetadata(value: unknown): LoaderMod | null {
  const root = record(value)
  const mods = list(root.mods).map(record)
  const ids = mods.flatMap((mod) => text(mod.modId) ?? [])
  if (ids.length === 0) return null
  const requirements = ids.flatMap((id) =>
    list(record(root.dependencies)[id]).flatMap((value) => {
      const dependency = record(value)
      const required = dependency.type === 'required' || dependency.mandatory === true
      const name = text(dependency.modId)
      return required && dependency.side !== 'CLIENT' && name !== undefined
        ? [{ id: name, versions: ranges(dependency.versionRange) }]
        : []
    }),
  )
  return {
    ids,
    depends: requirements
      .map((requirement) => requirement.id)
      .filter((id) => !['minecraft', 'forge', 'neoforge', 'java'].includes(id)),
    requirements,
    version: text(mods[0]?.version) ?? null,
    environment: root.clientSideOnly === true ? 'client' : 'both',
    carriesJars: false,
    complete: requirements.every((requirement) => requirement.versions.length > 0),
  }
}

function ranges(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : list(value).filter((item): item is string => typeof item === 'string')
}
