// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a jar asks of the server it runs on, read from the jar itself: the Java its classes need,
 * for a BentoBox add-on, the BentoBox it loads on, and for a Fabric mod, the mods it won't load
 * without (`fabricModOf`). A catalog lists the Minecraft releases a
 * version is for, never either of these, and they drift apart: BentoBox 3.23.3 lists 1.21.5 to
 * 26.3, yet its classes are Java 25's (class file 69), so Paper 1.21.11 on Java 21 leaves it out
 * at boot with an UnsupportedClassVersionError.
 *
 * Which classes to read comes from the files a jar names its entry class in, then a few classes
 * from its directory where it names none. Reading the bytes is a port's job; this says what they
 * mean. It is not where the Java a release runs on is decided (`versions.ts`, `javaFor`).
 */
import type { FabricMod } from '../domain/mods/jar-holds.ts'
import { isString, list, record, text } from './plain-data.ts'

/** The files a jar names its entry class in, with their format, for the caller to decode. */
export const ENTRY_FILES = {
  'plugin.yml': 'yaml',
  'paper-plugin.yml': 'yaml',
  /** A BentoBox addon's, which BentoBox loads itself. */
  'addon.yml': 'yaml',
  'fabric.mod.json': 'json',
  'quilt.mod.json': 'json',
  'META-INF/mods.toml': 'toml',
  'META-INF/neoforge.mods.toml': 'toml',
  'META-INF/MANIFEST.MF': 'manifest',
} as const
export type EntryFile = keyof typeof ENTRY_FILES

/** Classes read from a jar that names no entry class: enough to see past one odd class. */
const SAMPLED = 3

/** Class file majors start at Java 1.0's 45: Java 8 is 52, 21 is 65, 25 is 69. */
const MAJOR_OFFSET = 44
/** Past this, the bytes after the magic aren't a version any JVM wrote: Java gains one a year. */
const LATEST_PLAUSIBLE = 60

/** The Java release a class file needs; null for bytes that aren't a class file. */
export function javaOfClass(bytes: Uint8Array): number | null {
  if (bytes.length < 8) return null
  if (bytes[0] !== 0xca || bytes[1] !== 0xfe || bytes[2] !== 0xba || bytes[3] !== 0xbe) return null
  const major = ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)
  const java = major - MAJOR_OFFSET
  return java >= 1 && java <= LATEST_PLAUSIBLE ? java : null
}

/**
 * The class files to read from a jar holding `names`, given its entry files as decoded. The entry
 * classes it names, where they are in it; otherwise the first few classes outside `META-INF/`,
 * whose `versions/` folders hold classes only newer Java loads.
 */
export function classesToRead(
  names: readonly string[],
  decoded: Partial<Record<EntryFile, unknown>>,
  manifest?: string,
): string[] {
  const present = new Set(names)
  const named = entryClasses(decoded, manifest)
    .map((name) => `${name.replaceAll('.', '/')}.class`)
    .filter((path) => present.has(path))
  if (named.length > 0) return [...new Set(named)]
  return names.filter((name) => name.endsWith('.class') && !name.startsWith('META-INF/')).slice(0, SAMPLED)
}

/** The newest Java the classes read ask for; null when none was a class file. */
export function javaOfClasses(classes: Iterable<Uint8Array>): number | null {
  let newest: number | null = null
  for (const bytes of classes) {
    const java = javaOfClass(bytes)
    if (java !== null && (newest === null || java > newest)) newest = java
  }
  return newest
}

/**
 * The release of BentoBox an add-on loads on, from its addon.yml's `api-version`: AOneBlock 1.28.0
 * says 3.22.0, and BentoBox 3.16.2 leaves it out at boot. Null for a jar that is no add-on.
 */
export function addonNeeds(decoded: Partial<Record<EntryFile, unknown>>): string | null {
  const api = text(record(decoded['addon.yml'])['api-version'])?.trim()
  return api !== undefined && /^\d+(\.\d+)*$/.test(api) ? api : null
}

/** Mod ids Fabric Loader answers for itself; it bundles MixinExtras since 0.15. */
const LOADER_PROVIDES: ReadonlySet<string> = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'mixinextras',
])

/**
 * What a Fabric mod's jar says it needs, which a catalog may not list: spark's Fabric build names
 * no dependency on Modrinth, yet its fabric.mod.json requires `fabric-api-base`, and Fabric stopped
 * it at boot on staging (2026-10-11). A jar carried inside it counts for an id by its file name,
 * versions and a module's `-vN` aside: spark carries `fabric-permissions-api-0.7.0.jar` for
 * `fabric-permissions-api-v0`. Null for a jar that is no Fabric mod.
 */
export function fabricModOf(decoded: Partial<Record<EntryFile, unknown>>): FabricMod | null {
  const mod = record(decoded['fabric.mod.json'])
  const id = text(mod.id)
  if (id === undefined) return null
  const carried = list(mod.jars)
    .map((jar) => text(record(jar).file))
    .filter(isString)
    .map((file) => (file.split('/').pop() ?? '').replace(/\.jar$/, '').replace(/-\d.*$/, ''))
  const holds = (dependency: string) =>
    carried.includes(dependency) || carried.includes(dependency.replace(/-v\d+$/, ''))
  const depends = Object.keys(record(mod.depends)).filter((d) => !LOADER_PROVIDES.has(d) && !holds(d))
  return {
    ids: [id, ...list(mod.provides).map(text).filter(isString)],
    depends,
    carriesJars: carried.length > 0,
  }
}

/** Dotted class names a jar's entry files point at. */
function entryClasses(decoded: Partial<Record<EntryFile, unknown>>, manifest?: string): string[] {
  const classes: string[] = []
  for (const file of ['plugin.yml', 'paper-plugin.yml', 'addon.yml'] as const) {
    const main = text(record(decoded[file]).main)
    if (main !== undefined) classes.push(main.trim())
  }
  // Fabric names each entrypoint as a class, or as `{ value: "Class::member" }`.
  const entrypoints = record(record(decoded['fabric.mod.json']).entrypoints)
  for (const side of ['main', 'server'])
    for (const entry of list(entrypoints[side])) {
      const value = text(entry) ?? text(record(entry).value)
      if (value !== undefined) classes.push(value.split('::')[0]?.trim() ?? '')
    }
  const mainClass = /^Main-Class:\s*(\S+)\s*$/m.exec(manifest ?? '')?.[1]
  if (mainClass !== undefined) classes.push(mainClass)
  return classes.filter((name) => /^[\w$.]+$/.test(name))
}
