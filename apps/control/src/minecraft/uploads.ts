// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { isString, list, record, text } from './plain-data.ts'
import { compareVersions } from './versions.ts'
import { isLevelName, LEVEL_TYPES, type LevelType } from './worlds.ts'

/**
 * What uploaded files mean to Minecraft (§15.2): the loader metadata inside a mod or plugin jar,
 * and the world inside a download someone brings back. Decoding the formats is a port's job;
 * this reads the plain data it returns.
 */

/** The files a jar declares itself in, in the order they are trusted, with their format. */
export const JAR_METADATA = {
  'fabric.mod.json': 'json',
  'quilt.mod.json': 'json',
  'META-INF/neoforge.mods.toml': 'toml',
  'META-INF/mods.toml': 'toml',
  'paper-plugin.yml': 'yaml',
  'plugin.yml': 'yaml',
  'mcmod.info': 'json',
} as const
export type JarMetadataFile = keyof typeof JAR_METADATA

/**
 * An uploaded jar's name as it may sit on disk and in a link: its last path segment, with
 * anything but letters, digits and `._+-` made a dash. Null when it isn't a jar's name.
 */
export function jarFileName(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() ?? '').trim()
  const safe = base.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^[-.]+/, '')
  if (!/\.jar$/i.test(safe) || safe.length < 5 || safe.length > 120) return null
  return safe
}

/** Where Forge's jar version placeholder is filled from. */
export const JAR_MANIFEST = 'META-INF/MANIFEST.MF'

/** Forge's build tooling leaves this in mods.toml for the jar's own version. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Forge's literal placeholder, not a template.
export const JAR_VERSION_PLACEHOLDER = '${file.jarVersion}'

/** One comparison with a game version. */
interface VersionBound {
  op: '<' | '<=' | '>' | '>=' | '='
  version: string
}

/** Any one of the alternatives, each all of its bounds. No alternatives: any version. */
export type VersionRange = VersionBound[][]

export interface ModMetadata {
  /** The file it declared itself in. */
  format: JarMetadataFile
  id: string
  name: string
  version: string
  /** Loader tags as the catalog uses them: fabric, quilt, forge, neoforge, paper, bukkit. */
  loaders: string[]
  /** `client` for what only runs in players' games. */
  environment: 'server' | 'both' | 'client'
  gameVersions: VersionRange
  /** The Fabric or Quilt Loader builds it accepts, where it says; the others' loaders aren't read. */
  loaderVersions?: VersionRange
}

/**
 * A jar's own account of itself, from the metadata files it holds (decoded), or null when it
 * holds none a loader reads. Loaders are every one it declares; everything else comes from the
 * first file in trust order.
 */
export function modMetadata(
  files: Partial<Record<JarMetadataFile, unknown>>,
  manifest?: string,
): ModMetadata | null {
  const present = (Object.keys(JAR_METADATA) as JarMetadataFile[]).filter((f) => files[f] !== undefined)
  const [first] = present
  if (first === undefined) return null
  const read = present.map((format) => READERS[format](files[format], manifest))
  const main = read[0] as Omit<ModMetadata, 'format'>
  return {
    ...main,
    format: first,
    loaders: [...new Set(read.flatMap((r) => r.loaders))],
  }
}

/** Whether a game version is one the range allows. */
export function fits(range: VersionRange, version: string): boolean {
  return range.length === 0 || range.some((all) => all.every((bound) => holds(bound, version)))
}

function holds({ op, version: bound }: VersionBound, version: string): boolean {
  // A pre-release is never a release Blockly offers.
  if (op === '=') return !bound.includes('-') && compareVersions(version, bound) === 0
  const order = compareVersions(version, bound)
  if (op === '<') return order < 0
  if (op === '<=') return order <= 0
  if (op === '>') return order > 0
  return order >= 0
}

// ─── Readers, one per metadata file ─────────────────────────────────────────────────────────

type Reader = (data: unknown, manifest?: string) => Omit<ModMetadata, 'format'>

const READERS: Record<JarMetadataFile, Reader> = {
  'fabric.mod.json': (data) => {
    const json = record(data)
    const id = text(json.id) ?? 'unknown'
    return {
      id,
      name: text(json.name) ?? id,
      version: text(json.version) ?? '',
      loaders: ['fabric'],
      environment: environmentOf(text(json.environment), { client: 'client', server: 'server' }),
      gameVersions: fabricRange(record(json.depends).minecraft),
      loaderVersions: fabricRange(record(json.depends).fabricloader),
    }
  },
  'quilt.mod.json': (data) => {
    const json = record(data)
    const loader = record(json.quilt_loader)
    const id = text(loader.id) ?? 'unknown'
    const dependency = (id: string) =>
      list(loader.depends).find((d) => (typeof d === 'string' ? d : text(record(d).id)) === id)
    const minecraft = dependency('minecraft')
    const quiltLoader = dependency('quilt_loader')
    return {
      id,
      name: text(record(loader.metadata).name) ?? id,
      version: text(loader.version) ?? '',
      loaders: ['quilt'],
      environment: environmentOf(text(record(json.minecraft).environment), {
        client: 'client',
        dedicated_server: 'server',
      }),
      gameVersions:
        minecraft === undefined || typeof minecraft === 'string'
          ? []
          : quiltRange(record(minecraft).versions),
      loaderVersions:
        quiltLoader === undefined || typeof quiltLoader === 'string'
          ? []
          : quiltRange(record(quiltLoader).versions),
    }
  },
  'META-INF/neoforge.mods.toml': (data, manifest) => forgeMetadata(data, manifest, 'neoforge'),
  'META-INF/mods.toml': (data, manifest) => forgeMetadata(data, manifest, null),
  'paper-plugin.yml': (data) => pluginMetadata(data, 'paper'),
  'plugin.yml': (data) => pluginMetadata(data, 'bukkit'),
  'mcmod.info': (data) => {
    // Old Forge: a list of mods, or `{ modList: [...] }` in its second format.
    const mods = Array.isArray(data) ? data : list(record(data).modList)
    const mod = record(mods[0])
    const id = text(mod.modid) ?? 'unknown'
    const minecraft = text(mod.mcversion)
    return {
      id,
      name: text(mod.name) ?? id,
      version: text(mod.version) ?? '',
      loaders: ['forge'],
      environment: 'both',
      gameVersions: minecraft ? [[{ op: '=', version: minecraft }]] : [],
    }
  },
}

function forgeMetadata(data: unknown, manifest: string | undefined, loader: 'neoforge' | null) {
  const toml = record(data)
  const mod = record(list(toml.mods)[0])
  const id = text(mod.modId) ?? 'unknown'
  const dependencies = list(record(toml.dependencies)[id]).map(record)
  const on = (dep: string) => dependencies.find((d) => text(d.modId) === dep)
  const minecraft = on('minecraft')
  // No environment in mods.toml: a mod whose game and loader are needed only on the client, or
  // that says it is client-side only (Forge 1.20+), runs only in players' games.
  const platform = dependencies.filter((d) =>
    ['minecraft', 'forge', 'neoforge'].includes(text(d.modId) ?? ''),
  )
  const clientOnly =
    toml.clientSideOnly === true ||
    (platform.length > 0 && platform.every((d) => text(d.side)?.toUpperCase() === 'CLIENT'))
  let version = text(mod.version) ?? ''
  if (version.includes(JAR_VERSION_PLACEHOLDER))
    version = version.replace(
      JAR_VERSION_PLACEHOLDER,
      manifestValue(manifest, 'Implementation-Version') ?? '',
    )
  return {
    id,
    name: text(mod.displayName) ?? id,
    version,
    loaders: [loader ?? (on('neoforge') ? 'neoforge' : 'forge')],
    environment: clientOnly ? ('client' as const) : ('both' as const),
    gameVersions: minecraft ? mavenRange(text(minecraft.versionRange) ?? '') : [],
  }
}

function pluginMetadata(data: unknown, loader: 'paper' | 'bukkit') {
  const yaml = record(data)
  const id = text(yaml.name) ?? 'unknown'
  const api = text(yaml['api-version'])
  return {
    id,
    name: id,
    version: text(yaml.version) ?? '',
    loaders: [loader],
    environment: 'server' as const,
    // The oldest API a plugin was written for; later servers still load it.
    gameVersions: api ? [[{ op: '>=' as const, version: api }]] : [],
  }
}

// ─── Version syntaxes ───────────────────────────────────────────────────────────────────────

/**
 * Fabric's `depends.minecraft`: one predicate string, or a list of alternatives. A predicate is
 * space-separated comparisons, all of which must hold: `>=1.21- <1.21.2-`, `~1.20.1`, `1.20.x`.
 */
export function fabricRange(value: unknown): VersionRange {
  const alternatives = typeof value === 'string' ? [value] : list(value).map(text).filter(isString)
  const range = alternatives.map((alternative) => alternative.trim().split(/\s+/).flatMap(fabricPredicate))
  return range.some((all) => all.length === 0) ? [] : range
}

/** Quilt's version specifiers: a string, a list of alternatives, or `{ any: [...] }` / `{ all: [...] }`. */
export function quiltRange(value: unknown): VersionRange {
  if (value === undefined) return []
  if (typeof value === 'string') return fabricRange(value)
  const spec = record(value)
  const alternatives = Array.isArray(value) ? value : Array.isArray(spec.any) ? spec.any : null
  if (alternatives !== null) {
    const ranges = alternatives.map(quiltRange)
    // Any one of them may hold: one that allows every version allows every version.
    return ranges.some((r) => r.length === 0) ? [] : ranges.flat()
  }
  if (Array.isArray(spec.all)) {
    // Every part must hold: each alternative of one part with each of the next.
    let combined: VersionRange = [[]]
    for (const part of spec.all) {
      const range = quiltRange(part)
      if (range.length > 0) combined = combined.flatMap((left) => range.map((right) => [...left, ...right]))
    }
    return combined.some((all) => all.length === 0) ? [] : combined
  }
  return []
}

function fabricPredicate(predicate: string): VersionBound[] {
  const match = /^(>=|<=|>|<|=|~|\^)?(.*)$/.exec(predicate.trim())
  const op = match?.[1] ?? '='
  const raw = (match?.[2] ?? '').replace(/\+.*$/, '')
  if (raw === '' || raw === '*' || /^[xX*]$/.test(raw)) return []
  const wildcard = raw.split('.').findIndex((part) => /^[xX*]$/.test(part))
  if (wildcard > 0) {
    const fixed = raw.split('.').slice(0, wildcard)
    return [
      { op: '>=', version: fixed.join('.') },
      { op: '<', version: bump(fixed, wildcard - 1) },
    ]
  }
  // `1.21-` means "1.21 and its pre-releases": for releases, 1.21 itself.
  const release = raw.endsWith('-') ? raw.slice(0, -1) : raw
  const base = release.split('-')[0] ?? release
  const parts = base.split('.')
  switch (op) {
    case '~':
      return [
        { op: '>=', version: base },
        { op: '<', version: bump(parts, Math.min(1, parts.length - 1)) },
      ]
    case '^':
      return [
        { op: '>=', version: base },
        { op: '<', version: bump(parts, 0) },
      ]
    case '=':
      return [{ op: '=', version: release }]
    default:
      return [{ op: op as VersionBound['op'], version: base }]
  }
}

/** The version one step past `parts` at `index`: 1.20.1 at 1 is 1.21. */
function bump(parts: readonly string[], index: number): string {
  const kept = parts.slice(0, index + 1).map((p) => Number.parseInt(p, 10) || 0)
  kept[index] = (kept[index] ?? 0) + 1
  return kept.join('.')
}

/**
 * Maven version ranges, as Forge and NeoForge use them: `[1.20.1,1.21)`, `[1.21]`, `(,1.21]`,
 * several separated by commas. A bare version is taken as that version: in Maven it is only a
 * preference, but a mod built for one release rarely runs on another.
 */
export function mavenRange(spec: string): VersionRange {
  const trimmed = spec.replace(/\s+/g, '')
  if (trimmed === '' || trimmed === '*') return []
  if (!/^[[(]/.test(trimmed)) return [[{ op: '=', version: trimmed }]]
  const range: VersionRange = []
  for (const [, open, body, close] of trimmed.matchAll(/([[(])([^\])]*)([\])])/g)) {
    const [low = '', high] = (body ?? '').split(',')
    if (high === undefined) {
      range.push([{ op: '=', version: low }])
      continue
    }
    const all: VersionBound[] = []
    if (low !== '') all.push({ op: open === '[' ? '>=' : '>', version: low })
    if (high !== '') all.push({ op: close === ']' ? '<=' : '<', version: high })
    range.push(all)
  }
  return range
}

// ─── Uploaded worlds ────────────────────────────────────────────────────────────────────────

/** A world brought back from a download: what its files say about it. */
export interface UploadedWorld {
  levelName: string
  levelType: LevelType
  seed: string | null
  hardcore: boolean
  /** The game version that last saved it. */
  gameVersion: string
}

/** Where a server keeps its settings, the world's name among them. */
export const PROPERTIES_FILE = 'server.properties'

/**
 * A jar in a download that Minecraft alone doesn't run: a mod or a plugin. A world made with them
 * can hold blocks and items plain Minecraft doesn't know, which it would drop on opening.
 */
export const isAddedJar = (path: string): boolean => /^(mods|plugins)\/[^/]+\.jar$/.test(path)

/** The archive entries worth reading: the server's properties and each world's level.dat. */
export const wantedInWorldArchive = (path: string): boolean =>
  path === PROPERTIES_FILE || /^[^/]+\/level\.dat$/.test(path)

/** The world a server's properties name, if it is one Blockly can run. */
export function levelNameOf(properties: Readonly<Record<string, string>>): string | null {
  const name = properties['level-name']?.trim() || 'world'
  return isLevelName(name) ? name : null
}

/**
 * The world in an uploaded download: named by its server.properties, described by its own
 * level.dat. A refusal explains what the person can fix.
 */
export function uploadedWorld(
  properties: Readonly<Record<string, string>> | null,
  levelDat: unknown,
): UploadedWorld | { refused: string } {
  if (properties === null)
    return { refused: 'This isn’t a Cubepals download: it has no server.properties naming its world.' }
  const levelName = levelNameOf(properties)
  if (levelName === null)
    return {
      refused: `The world folder “${properties['level-name']}” isn’t one Cubepals can run: use lowercase letters, digits, - and _ in its name and in level-name.`,
    }
  if (levelDat === undefined)
    return { refused: `The download has no ${levelName}/level.dat, so it holds no world to restore.` }
  const version = text(record(record(record(levelDat).Data).Version).Name)
  if (!version) return { refused: 'This world is from before Minecraft 1.9, too old to open here.' }
  return {
    levelName,
    levelType: levelTypeOf(properties['level-type']),
    seed: properties['level-seed']?.trim() || null,
    hardcore: properties.hardcore?.trim() === 'true',
    gameVersion: version,
  }
}

/** Older servers wrote `DEFAULT`, `largeBiomes` and friends; anything unknown generates as normal. */
function levelTypeOf(value: string | undefined): LevelType {
  const key = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
  const named = LEVEL_TYPES.find((t) => t === `minecraft:${key}`)
  if (named) return named
  if (key === 'largebiomes') return 'minecraft:large_biomes'
  return 'minecraft:normal'
}

// ─── Plain-data helpers ─────────────────────────────────────────────────────────────────────

function environmentOf(
  value: string | undefined,
  names: Record<string, 'client' | 'server'>,
): 'client' | 'server' | 'both' {
  return (value && names[value]) || 'both'
}

function manifestValue(manifest: string | undefined, key: string): string | undefined {
  const line = manifest?.split(/\r?\n/).find((l) => l.startsWith(`${key}:`))
  return line?.slice(key.length + 1).trim() || undefined
}
