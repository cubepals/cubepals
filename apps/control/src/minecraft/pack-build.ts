// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModEnvironment } from '../domain/mods/catalog.ts'
import type { MemoryTier } from '../domain/server/size.ts'
import { serverEnvironment } from './mods.ts'
import type { PackLoader } from './mrpack.ts'
import { fits, type ModMetadata } from './uploads.ts'
import { compareVersions } from './versions.ts'

/**
 * The Minecraft decisions in building a server pack from what someone uploaded
 * (docs/modpack-system.md): which of its jars a server runs, what it runs on when the pack itself
 * doesn't say, the size it starts on, and what to tell its owner about what was done.
 */

/**
 * Where a jar of a pack runs, from the best evidence there is. The catalog's own record of that
 * exact file comes first: Modrinth's per-version environment is right far more often than a pack's
 * marks (Better MC 4 marks 63 mods made for players' games as needed on the server, 2026-09-26).
 * Then what the jar says of itself. With neither, it runs on both sides, which is what almost
 * every mod does.
 */
export function jarSide(evidence: {
  catalog?: ModEnvironment | null
  metadata?: Pick<ModMetadata, 'environment'> | null
}): 'server' | 'optional' | 'both' | 'client' {
  if (evidence.catalog && evidence.catalog !== 'unknown')
    return serverEnvironment(evidence.catalog) ?? 'client'
  if (evidence.metadata?.environment === 'client') return 'client'
  if (evidence.metadata?.environment === 'server') return 'server'
  return 'both'
}

/**
 * What a folder of mods runs on, from the mods themselves: the loader they are written for and the
 * newest Minecraft every one of them allows. NeoForge's `neoforge.mods.toml` names NeoForge; Forge's
 * `mods.toml` is read by NeoForge too, so a folder with both is NeoForge's; Quilt loads Fabric's mods.
 */
export function runsOn(
  mods: ReadonlyArray<Pick<ModMetadata, 'id' | 'loaders' | 'gameVersions' | 'format'>>,
  candidates: readonly string[],
): { loader: PackLoader; gameVersion: string } | { refused: string } {
  const loaded = mods.filter((mod) => mod.format !== 'plugin.yml' && mod.format !== 'paper-plugin.yml')
  if (loaded.length === 0) return { refused: 'This pack holds no mods Cubepals can read.' }
  const has = (loader: string) => loaded.some((mod) => mod.loaders.includes(loader))
  const loader: PackLoader = has('neoforge')
    ? 'neoforge'
    : has('forge')
      ? 'forge'
      : has('quilt')
        ? 'quilt'
        : 'fabric'
  // A Fabric mod beside Forge's is a mix a server can't run, unless the pack carries Sinytra
  // Connector, which runs Fabric's mods on NeoForge.
  const bridged = loaded.some((mod) => mod.id === 'connectormod' || mod.id === 'connector')
  if ((loader === 'forge' || loader === 'neoforge') && (has('fabric') || has('quilt')) && !bridged)
    return { refused: 'This pack’s mods are for different mod loaders, so they can’t run as one server.' }
  const releases = [...new Set(candidates)].sort((a, b) => compareVersions(b, a))
  const gameVersion = releases.find((release) => loaded.every((mod) => fits(mod.gameVersions, release)))
  if (gameVersion === undefined)
    return {
      refused: 'This pack’s mods are for different Minecraft versions, so they can’t run as one server.',
    }
  return { loader, gameVersion }
}

/**
 * Releases the mods themselves name, to choose from beside the ones Blockly offers: a mod written
 * for 1.12.2 says so in its range, and that is the release it runs on.
 */
export function namedReleases(mods: ReadonlyArray<Pick<ModMetadata, 'gameVersions'>>): string[] {
  return mods
    .flatMap((mod) =>
      mod.gameVersions.flatMap((all) =>
        all
          .filter((bound) => bound.op === '=' || bound.op === '>=' || bound.op === '<=')
          .map((b) => b.version),
      ),
    )
    .filter((version) => /^\d+\.\d+(\.\d+)?$/.test(version))
}

/**
 * The oldest Minecraft a pack may run on: 1.12.2, where RLCraft and SkyFactory 4 live. Older
 * packs wait until one has booted on the image here.
 */
const OLDEST_PACK_RELEASE = '1.12.2'

export const oldEnough = (gameVersion: string): boolean =>
  compareVersions(gameVersion, OLDEST_PACK_RELEASE) >= 0

/**
 * The size a pack starts on (§15.6). What its author says it needs comes first: a server pack's
 * `-Xmx`, a CurseForge export's recommended memory. That is a heap, and authors are generous with
 * it (the packs measured lived in a fraction of what they asked for, docs/minecraft-capacity-
 * research.md), so up to 2.5 GB is the smallest size, up to 4.5 GB the middle one, and more the
 * large one. Past that, the catalog's own tags, then what its jars weigh, where many mods and heavy
 * jars mean the large size. The first boot still settles it: a pack that runs out of room is
 * offered the next size in one press.
 */
export function packTierFor(signals: {
  memoryMb: number | null
  categories?: readonly string[]
  mods: number
  jarBytes: number
}): MemoryTier {
  if (signals.memoryMb !== null) {
    if (signals.memoryMb <= 2560) return '3g'
    if (signals.memoryMb <= 4608) return '4g'
    return '8g'
  }
  const categories = signals.categories ?? []
  if (categories.includes('kitchen-sink')) return '8g'
  if (categories.includes('lightweight')) return '3g'
  // A pack that says nothing takes the middle, where every pack measured sat; only a heavy one
  // is sized up by its jars, never a light-looking one down.
  const megabytes = signals.jarBytes / (1024 * 1024)
  if (signals.mods < 150 && megabytes < 400) return '4g'
  return '8g'
}

/** More memory than Blockly's largest server has, in megabytes: a pack asking for more is told so. */
const LARGEST_SERVER_MB = 8192

// ─── What the owner is told ─────────────────────────────────────────────────────────────────

/**
 * A pack's name and version from its file's name, for a pack that says nothing else about itself.
 * Server packs are named for their pack, the words "server files" and a version:
 * `Create-Above-and-Beyond-Server-1.3.zip` is Create Above and Beyond, version 1.3.
 */
export function packNameOf(fileName: string): { name: string; version: string | null } {
  const words = (fileName.split('/').pop() ?? fileName)
    .replace(/\.(zip|mrpack)$/i, '')
    .replace(/[-_\s]+/g, ' ')
    .trim()
  const bare = (text: string) => text.replace(SERVER_WORDS, '').trim()
  const rest = bare(words)
  const found = / (v?\d+(?:\.\d+)*[a-z]?)$/i.exec(rest)
  const version = found?.[1] ?? null
  const name = bare(found === null ? rest : rest.slice(0, found.index))
  // A file named for nothing but the words and a version keeps its words rather than no name.
  return {
    name: name || (found === null ? rest : rest.slice(0, found.index)) || words || 'A modpack',
    version,
  }
}
const SERVER_WORDS = /(^| )(server( ?(files|pack))?|serverfiles|serverpack)$/i

/** A name for a jar a person recognises: its file name without the extension and the version. */
export function modName(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.jar$/i, '')
  const cut = base.search(/[-_+](v?\d|mc\d|fabric|forge|neoforge|quilt)/i)
  return (cut > 0 ? base.slice(0, cut) : base).replace(/[-_]+/g, ' ').trim() || base
}

/**
 * The one jar of a pack that a mod's name, as its loader printed it, points at: "Fog Overrides" is
 * `mods/fogoverrides-1.20.1-1.3.jar`. None when no jar fits, or more than one does.
 */
export function jarNamed(paths: readonly string[], name: string): string | null {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = plain(name)
  if (wanted.length < 3) return null
  const exact = paths.filter((path) => plain(modName(path)) === wanted)
  if (exact.length > 0) return exact.length === 1 ? (exact[0] ?? null) : null
  const near = paths.filter((path) => {
    const own = plain(modName(path))
    return own.length >= 4 && (own.includes(wanted) || wanted.includes(own))
  })
  return near.length === 1 ? (near[0] ?? null) : null
}

/**
 * What a pack server leaves out now: what was pinned with it, and what its pack learned since
 * (`crashed`: a mod that stopped one of its servers as it started), less what the pack put back.
 * A learned jar may be one the pack lists or one it carries in its overrides; both are said.
 */
export function leaveOutNow(
  pinned: readonly string[],
  learned: ReadonlyArray<{ path: string; why: string }> | null,
): string[] {
  if (learned === null) return [...pinned]
  const still = new Set(learned.map((l) => l.path))
  const crashed = learned
    .filter((l) => l.why === 'crashed')
    .flatMap((l) => (/^(server-)?overrides\//.test(l.path) ? [l.path] : [l.path, `overrides/${l.path}`]))
  return [...new Set([...pinned.filter((path) => still.has(path)), ...crashed])]
}

/** One list of names as a sentence reads it: "A, B, C and 4 more". */
export function someNames(names: readonly string[], shown = 3): string {
  const unique = [...new Set(names)]
  if (unique.length <= shown + 1)
    return unique.length <= 1 ? (unique[0] ?? '') : `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`
  return `${unique.slice(0, shown).join(', ')} and ${unique.length - shown} more`
}

/** The sentences a built pack carries for its owner, only for what they'd want to know. */
export function packNotes(built: {
  leftOutForPlayers: readonly string[]
  worlds: number
  memoryMb: number | null
}): string[] {
  const notes: string[] = []
  const players = built.leftOutForPlayers
  if (players.length > 0)
    notes.push(
      `Cubepals left out ${players.length === 1 ? 'one mod' : `${players.length} mods`} made for players’ games: ${someNames(players.map(modName))}.`,
    )
  if (built.worlds > 0)
    notes.push('The pack came with a world of its own; the server makes a new one, as the pack sets it up.')
  if (built.memoryMb !== null && built.memoryMb > LARGEST_SERVER_MB)
    notes.push(
      'Its author asks for more than Cubepals’ largest server, so it may run slowly with many players.',
    )
  return notes
}
