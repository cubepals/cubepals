// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PackLoader } from './mrpack.ts'
import { record, releaseId, text } from './plain-data.ts'

/**
 * What a server pack says about how it starts, read and never run: the loader and its version,
 * the Minecraft it is for, and the memory and Java properties its author starts it with. Authors
 * say it in different places, and each is read the way its own tool writes it:
 *
 * - `variables.txt`, ServerPackCreator's (the tool CurseForge's own tutorial points authors to):
 *   `MINECRAFT_VERSION=`, `MODLOADER=`, `MODLOADER_VERSION=`, `JAVA_ARGS=`.
 * - `server-setup-config.yaml`, ServerStarter's: `install.mcVersion`, `install.loaderVersion`,
 *   `launch.maxRam`, and whether it downloads its mods itself as it starts.
 * - The start scripts: Forge's and NeoForge's own run script (`@libraries/…/unix_args.txt`), and
 *   the variables a pack's own start script sets (`NEOFORGE_VERSION=`, `FORGE_VERSION=`).
 * - `user_jvm_args.txt`, where Forge and NeoForge keep the memory a pack asks for.
 * - The names of the installers, launchers and libraries it ships.
 *
 * The first place that names a thing wins, in that order; the mods' own metadata is the caller's
 * last resort for what none of them says.
 */

export interface StartInfo {
  loader: PackLoader | null
  loaderVersion: string | null
  gameVersion: string | null
  /** The most memory its author starts it with, in megabytes. */
  memoryMb: number | null
  /** `-D` properties its author starts it with, which some packs need (`fml.queryResult=confirm`). */
  javaProperties: Record<string, string>
  /** It fetches its own mods as it starts, from a manifest, instead of shipping them. */
  downloadsOwnMods: boolean
}

export interface StartFiles {
  /** Every file name in the pack, relative to its top. */
  names: readonly string[]
  /** The text of the small files that say how it starts, by name. */
  texts: Readonly<Record<string, string>>
  /** `server-setup-config.yaml`, decoded. */
  serverStarter?: unknown
}

/** The files whose text says how a pack starts, to read before `startInfo`. */
export function startFilesWanted(name: string): boolean {
  return (
    name === 'variables.txt' ||
    name === 'user_jvm_args.txt' ||
    name === 'server-setup-config.yaml' ||
    name === 'fabric-server-launcher.properties' ||
    /^[^/]+\.(sh|bat|cmd|ps1)$/i.test(name)
  )
}

export function startInfo(files: StartFiles): StartInfo {
  const found: StartInfo = {
    loader: null,
    loaderVersion: null,
    gameVersion: null,
    memoryMb: null,
    javaProperties: {},
    downloadsOwnMods: false,
  }
  const take = (next: Partial<StartInfo>) => {
    if (found.loader === null && next.loader) {
      found.loader = next.loader
      if (next.loaderVersion) found.loaderVersion = next.loaderVersion
    } else if (
      found.loader !== null &&
      found.loader === next.loader &&
      !found.loaderVersion &&
      next.loaderVersion
    )
      found.loaderVersion = next.loaderVersion
    if (found.gameVersion === null && next.gameVersion) found.gameVersion = next.gameVersion
    if (found.memoryMb === null && next.memoryMb) found.memoryMb = next.memoryMb
  }

  const variables = files.texts['variables.txt']
  if (variables !== undefined) take(fromVariables(variables))
  if (files.serverStarter !== undefined) {
    const starter = fromServerStarter(files.serverStarter)
    take(starter)
    found.downloadsOwnMods = starter.downloadsOwnMods === true
  }
  const scripts = Object.entries(files.texts).filter(([name]) => /\.(sh|bat|cmd|ps1)$/i.test(name))
  for (const [, text] of scripts) take(fromScript(text))
  const jvmArgs = files.texts['user_jvm_args.txt']
  for (const text of [jvmArgs, variables, ...scripts.map(([, t]) => t)])
    if (text !== undefined) {
      found.memoryMb ??= maxMemory(text)
      Object.assign(found.javaProperties, { ...javaProperties(text), ...found.javaProperties })
    }
  take(fromNames(files.names))
  const launcher = files.texts['fabric-server-launcher.properties']
  if (launcher !== undefined && found.loader === null) take({ loader: 'fabric' })
  if (found.loader === 'neoforge' && found.gameVersion === null && found.loaderVersion)
    found.gameVersion = neoForgeGame(found.loaderVersion)
  return found
}

// ─── Each place a pack says it ──────────────────────────────────────────────────────────────

const LOADER_NAMES: Record<string, PackLoader> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric',
  quilt: 'quilt',
}

function fromVariables(text: string): Partial<StartInfo> {
  const values = assignments(text)
  const loader = LOADER_NAMES[(values.MODLOADER ?? '').toLowerCase()]
  return {
    ...(loader === undefined ? {} : { loader }),
    loaderVersion: values.MODLOADER_VERSION ?? null,
    gameVersion: releaseId(values.MINECRAFT_VERSION),
  }
}

function fromServerStarter(data: unknown): Partial<StartInfo> & { downloadsOwnMods?: boolean } {
  const install = record(record(data).install)
  const launch = record(record(data).launch)
  // ServerStarter installs Forge; its config names the build without the loader.
  const modpackUrl = text(install.modpackUrl) ?? ''
  const format = text(install.modpackFormat) ?? ''
  return {
    loader: 'forge',
    loaderVersion: text(install.loaderVersion) ?? null,
    gameVersion: releaseId(text(install.mcVersion)),
    memoryMb: megabytes(text(launch.maxRam)),
    downloadsOwnMods: modpackUrl !== '' || /curse/i.test(format),
  }
}

/** A start script: the libraries it runs from, and the variables it sets. */
function fromScript(text: string): Partial<StartInfo> {
  const forgeArgs =
    /libraries\/net\/minecraftforge\/forge\/(\d[\w.]*)-(\d[\w.-]*)\/(unix|win)_args\.txt/.exec(text)
  if (forgeArgs) return { loader: 'forge', gameVersion: forgeArgs[1], loaderVersion: forgeArgs[2] }
  const neoArgs = /libraries\/net\/neoforged\/neoforge\/(\d[\w.-]*)\/(unix|win)_args\.txt/.exec(text)
  if (neoArgs?.[1]) return { loader: 'neoforge', loaderVersion: neoArgs[1] }
  const values = assignments(text)
  if (values.NEOFORGE_VERSION) return { loader: 'neoforge', loaderVersion: values.NEOFORGE_VERSION }
  if (values.FORGE_VERSION)
    return {
      loader: 'forge',
      loaderVersion: values.FORGE_VERSION,
      gameVersion: releaseId(values.MINECRAFT_VERSION ?? values.MC_VERSION),
    }
  if (values.FABRIC_LOADER_VERSION || values.FABRIC_VERSION)
    return {
      loader: 'fabric',
      loaderVersion: values.FABRIC_LOADER_VERSION ?? values.FABRIC_VERSION ?? null,
      gameVersion: releaseId(values.MINECRAFT_VERSION ?? values.MC_VERSION),
    }
  return fromNames(text.match(/[\w.+-]+\.jar/g) ?? [])
}

/** The installers, launchers and libraries a pack ships, by their names. */
function fromNames(names: readonly string[]): Partial<StartInfo> {
  for (const name of names) {
    const base = name.split('/').pop() ?? name
    const forge = /^forge-(\d[\w.]*)-(\d[\w.-]*?)(?:-installer|-universal|-server)?\.jar$/i.exec(base)
    if (forge && !name.includes('/'))
      return { loader: 'forge', gameVersion: forge[1], loaderVersion: forge[2] ?? null }
    const neo = /^neoforge-(\d[\w.-]*?)(?:-installer|-universal)?\.jar$/i.exec(base)
    if (neo?.[1] && !name.includes('/')) return { loader: 'neoforge', loaderVersion: neo[1] }
    const fabricServer = /^fabric-server-mc\.(\d[\w.]*)-loader\.(\d[\w.]*)-launcher\./i.exec(base)
    if (fabricServer)
      return { loader: 'fabric', gameVersion: fabricServer[1], loaderVersion: fabricServer[2] }
  }
  const library = (pattern: RegExp) => names.map((name) => pattern.exec(name)).find((match) => match !== null)
  const forgeLibrary = library(/^libraries\/net\/minecraftforge\/forge\/(\d[\w.]*)-(\d[\w.-]*)\//)
  if (forgeLibrary)
    return { loader: 'forge', gameVersion: forgeLibrary[1], loaderVersion: forgeLibrary[2] ?? null }
  const neoLibrary = library(/^libraries\/net\/neoforged\/neoforge\/(\d[\w.-]*)\//)
  if (neoLibrary?.[1]) return { loader: 'neoforge', loaderVersion: neoLibrary[1] }
  const quiltLibrary = library(/^libraries\/org\/quiltmc\/quilt-loader\/(\d[\w.-]*)\//)
  if (quiltLibrary?.[1]) return { loader: 'quilt', loaderVersion: quiltLibrary[1] }
  const fabricLibrary = library(/^libraries\/net\/fabricmc\/fabric-loader\/(\d[\w.-]*)\//)
  if (fabricLibrary?.[1]) return { loader: 'fabric', loaderVersion: fabricLibrary[1] }
  if (names.some((name) => /^quilt-server-launch\.jar$/i.test(name))) return { loader: 'quilt' }
  if (names.some((name) => /^fabric-server-launch(er)?\.jar$/i.test(name))) return { loader: 'fabric' }
  const server = library(
    /^(?:libraries\/net\/minecraft\/server\/(\d[\w.]*)\/|minecraft_server\.(\d[\w.]*)\.jar$|versions\/(\d[\w.]*)\/)/,
  )
  if (server) return { gameVersion: server[1] ?? server[2] ?? server[3] ?? null }
  return {}
}

/**
 * The Minecraft a NeoForge build is for, by how NeoForge numbers them: 21.1.x is 1.21.1, 21.0.x
 * is 1.21, and the year-numbered releases keep their own numbers: 26.1.2.x is 26.1.2.
 */
export function neoForgeGame(version: string): string | null {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
  // 47.1.x is the Forge fork NeoForge made for 1.20.1, which names its release separately.
  if (!Number.isFinite(major) || major < 20 || major >= 40) return null
  if (major >= 26) return patch > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}`
  return minor > 0 ? `1.${major}.${minor}` : `1.${major}`
}

// ─── Memory and properties from JVM arguments ──────────────────────────────────────────────

/** The largest `-Xmx` in a text of JVM arguments, or a ServerStarter-style amount, in megabytes. */
export function maxMemory(text: string): number | null {
  const all = [...uncommented(text).matchAll(/-Xmx(\d+)([gGmMkK])?\b/g)].map((m) =>
    megabytes(`${m[1]}${m[2] ?? ''}`),
  )
  const known = all.filter((mb): mb is number => mb !== null)
  return known.length === 0 ? null : Math.max(...known)
}

function megabytes(amount: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([gGmMkK])?[bB]?$/.exec((amount ?? '').trim())
  if (!match) return null
  const value = Number.parseFloat(match[1] ?? '0')
  const unit = (match[2] ?? 'm').toLowerCase()
  const mb = unit === 'g' ? value * 1024 : unit === 'k' ? value / 1024 : value
  // A number without a unit is bytes to the JVM; nobody means a server that small.
  if (match[2] === undefined && value > 65_536) return Math.round(value / (1024 * 1024))
  return mb >= 256 ? Math.round(mb) : null
}

/**
 * `-Dname=value` properties in a text of JVM arguments. Only plain names and values are taken: a
 * property is how a pack tells a mod something, never a way to run something else.
 */
export function javaProperties(text: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of uncommented(text).matchAll(
    /(?:^|\s)-D([A-Za-z][\w.-]{0,63})=([\w.:,/-]{0,128})(?=\s|$|")/g,
  )) {
    const [, name = '', value = ''] = match
    if (!UNSAFE_PROPERTIES.test(name)) found[name] = value
  }
  return found
}

/** Properties that change how Java itself loads or reaches things, which a pack never needs to set. */
const UNSAFE_PROPERTIES =
  /^(java\.|jdk\.|sun\.|javax\.|user\.|file\.|os\.|log4j|com\.sun\.|jna\.|org\.lwjgl\.)/i

// ─── Plain-text helpers ─────────────────────────────────────────────────────────────────────

/** `NAME=value` and `set NAME=value` lines, as a start script or variables file writes them. */
function assignments(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of uncommented(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+|set\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const [, name = '', raw = ''] = match
    const value = raw.replace(/^["']|["']$/g, '')
    // A value built from other variables isn't a version anyone wrote down.
    if (value !== '' && !value.includes('$') && !value.includes('%')) values[name] ??= value
  }
  return values
}

function uncommented(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|::|rem\s|REM\s|\/\/)/.test(line))
    .join('\n')
}
