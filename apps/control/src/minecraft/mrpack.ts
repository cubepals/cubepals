// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Loader } from '../domain/revision/revision.ts'
import { isString, list, record } from './plain-data.ts'

/**
 * A Modrinth pack's index, `modrinth.index.json`, as its format defines it (Modrinth's "Modrinth
 * Modpack Format", format version 1, read 2026-09-26): the game, a list of files each with its
 * hashes, where it is downloaded and which sides need it, and the loader and Minecraft it runs on.
 * Files the index doesn't list come in `overrides/`, and `server-overrides/` over them on a server.
 *
 * It is also the one shape every pack Blockly runs is put in: a pack picked from the catalog is
 * its author's index, and one someone uploads in another format is written as one (packs/), so
 * the image installs every pack the same way.
 */

export const INDEX_FILE = 'modrinth.index.json'
export const OVERRIDES = 'overrides/'
export const SERVER_OVERRIDES = 'server-overrides/'

/** What a file asks of one side: needed, used when there, or never loaded there. */
type SideNeed = 'required' | 'optional' | 'unsupported'

export interface PackFile {
  /** Where it goes, relative to the server's directory, with forward slashes. */
  path: string
  sha1: string
  sha512: string
  sizeBytes: number
  /** Where it is downloaded, in order of preference. */
  downloads: string[]
  env: { client: SideNeed; server: SideNeed }
}

/** The loaders a pack can name, with the key each goes by in `dependencies`. */
export const PACK_LOADERS = {
  neoforge: 'neoforge',
  forge: 'forge',
  quilt: 'quilt-loader',
  fabric: 'fabric-loader',
} as const satisfies Partial<Record<Loader, string>>

export type PackLoader = keyof typeof PACK_LOADERS

export interface PackIndex {
  name: string
  /** The author's name for this version. */
  versionId: string
  summary: string | null
  gameVersion: string
  /** The loader it names; vanilla when it names none, which a pack of datapacks can. */
  loader: PackLoader | 'vanilla'
  loaderVersion: string | null
  files: PackFile[]
}

/**
 * The index a pack holds, or the one plain sentence that says why it can't be used. Anything
 * that would put a file outside the server's directory refuses the whole pack: a path is taken
 * as the format's own rule says, never repaired.
 */
export function readIndex(data: unknown): PackIndex | { refused: string } {
  const json = record(data)
  if (json.game !== 'minecraft' || json.formatVersion !== 1)
    return { refused: 'This pack is in a Modrinth format Cubepals doesn’t know.' }
  const dependencies = record(json.dependencies)
  const gameVersion = text(dependencies.minecraft)
  if (!gameVersion) return { refused: 'This pack doesn’t say which Minecraft it runs on.' }
  const loaders = (Object.keys(PACK_LOADERS) as PackLoader[]).filter(
    (loader) => text(dependencies[PACK_LOADERS[loader]]) !== undefined,
  )
  // Quilt runs Fabric's loader too, and a pack for Quilt may name both.
  const [loader] = loaders.includes('quilt') ? ['quilt' as const] : loaders
  if (loaders.length > 1 && loader !== 'quilt')
    return { refused: 'This pack names more than one mod loader, so it can’t run as one server.' }
  const files: PackFile[] = []
  for (const entry of list(json.files)) {
    const file = packFile(entry)
    if ('refused' in file) return file
    files.push(file)
  }
  return {
    name: text(json.name)?.trim() || 'A modpack',
    versionId: text(json.versionId)?.trim() || '',
    summary: text(json.summary)?.trim() || null,
    gameVersion,
    loader: loader ?? 'vanilla',
    loaderVersion: loader === undefined ? null : (text(dependencies[PACK_LOADERS[loader]]) ?? null),
    files,
  }
}

function packFile(data: unknown): PackFile | { refused: string } {
  const json = record(data)
  const path = text(json.path) ?? ''
  if (!isSafePath(path)) return { refused: 'This pack puts a file outside the server’s folder.' }
  const hashes = record(json.hashes)
  const sha1 = text(hashes.sha1)?.toLowerCase() ?? ''
  const sha512 = text(hashes.sha512)?.toLowerCase() ?? ''
  const downloads = list(json.downloads).map(text).filter(isString).filter(isDownload)
  if (!/^[0-9a-f]{40}$/.test(sha1) || !/^[0-9a-f]{128}$/.test(sha512) || downloads.length === 0)
    return { refused: `This pack lists ${lastSegment(path)} without a way to download and check it.` }
  const env = record(json.env)
  return {
    path,
    sha1,
    sha512,
    sizeBytes: typeof json.fileSize === 'number' && json.fileSize >= 0 ? json.fileSize : 0,
    downloads,
    env: { client: sideNeed(env.client), server: sideNeed(env.server) },
  }
}

/** A file without a side said is needed on both: the format's default. */
function sideNeed(value: unknown): SideNeed {
  return value === 'optional' || value === 'unsupported' ? value : 'required'
}

/** The files a server installs: every one its side doesn't refuse. */
export const serverFiles = (index: Pick<PackIndex, 'files'>): PackFile[] =>
  index.files.filter((file) => file.env.server !== 'unsupported')

/**
 * Whether players need anything to join: a file a server installs that players need too. One
 * that is optional or never loaded in players' games isn't a reason to install anything.
 */
export const playersNeedIt = (index: Pick<PackIndex, 'files'>): boolean =>
  serverFiles(index).some((file) => file.env.client === 'required' && isJar(file.path))

/**
 * A path a pack may write: relative, in forward slashes, every segment a plain name. No `..`, no
 * leading slash or drive, no backslash, nothing a filesystem treats specially.
 */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false
  // Control characters, including NUL, are never part of a name a pack means.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (/[\u0000-\u001f\u007f]/.test(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Only links a download can follow: the index's own rule leaves the scheme to the launcher. */
function isDownload(url: string): boolean {
  return /^https?:\/\/[^\s/]+\/\S+$/i.test(url)
}

export const isJar = (path: string): boolean => /\.jar$/i.test(path)

// ─── Plain-data helpers ─────────────────────────────────────────────────────────────────────

const lastSegment = (path: string) => path.split('/').pop() || path

/** Text as the index writes it: a number is not text here, unlike in plain-data.ts's `text`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
