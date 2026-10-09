import type { PackLoader } from './mrpack.ts'
import { list, record, releaseId, text } from './plain-data.ts'

/**
 * The files other launchers and tools describe a pack in, read as plain data: a CurseForge
 * export's `manifest.json`, a Prism or MultiMC instance's `mmc-pack.json` and `instance.cfg`, the
 * CurseForge app's `minecraftinstance.json`, and a Packwiz pack's TOML. Each says what the pack
 * runs on; which of them can become a server is the caller's to decide.
 */

export interface PackIdentity {
  name: string | null
  version: string | null
  gameVersion: string | null
  loader: PackLoader | null
  loaderVersion: string | null
  /** The memory its author recommends, in megabytes. */
  memoryMb: number | null
}

/** A loader as CurseForge and its app write it: `forge-47.2.0`, `neoforge-21.1.72`, `fabric-0.16.9`. */
export function loaderId(id: string | undefined): { loader: PackLoader; version: string } | null {
  const match = /^(neoforge|forge|fabric|quilt)-(.+)$/i.exec((id ?? '').trim())
  if (!match) return null
  return { loader: (match[1] ?? '').toLowerCase() as PackLoader, version: match[2] ?? '' }
}

// ─── CurseForge ────────────────────────────────────────────────────────────────────────────

export interface CurseForgeExport extends PackIdentity {
  /** The folder its own files come in; `overrides` unless it says otherwise. */
  overrides: string
  /** The mods it lists by CurseForge project and file, which only CurseForge's API can turn into files. */
  files: Array<{ projectId: number; fileId: number; required: boolean }>
}

/** A CurseForge export's `manifest.json`, or null when it isn't one. */
export function curseForgeExport(data: unknown): CurseForgeExport | null {
  const json = record(data)
  if (json.manifestType !== 'minecraftModpack') return null
  const minecraft = record(json.minecraft)
  const loaders = list(minecraft.modLoaders).map(record)
  const primary = loaders.find((l) => l.primary === true) ?? loaders[0]
  const loader = loaderId(text(primary?.id))
  const ram = typeof minecraft.recommendedRam === 'number' ? minecraft.recommendedRam : null
  return {
    name: text(json.name) ?? null,
    version: text(json.version) ?? null,
    gameVersion: releaseId(text(minecraft.version)),
    loader: loader?.loader ?? null,
    loaderVersion: loader?.version ?? null,
    memoryMb: ram !== null && ram >= 256 ? ram : null,
    overrides: (text(json.overrides) ?? 'overrides').replace(/\/+$/, ''),
    files: list(json.files)
      .map(record)
      .flatMap((file) =>
        typeof file.projectID === 'number' && typeof file.fileID === 'number'
          ? [{ projectId: file.projectID, fileId: file.fileID, required: file.required !== false }]
          : [],
      ),
  }
}

/** The CurseForge app's own `minecraftinstance.json`, in a zipped profile folder. */
export function curseForgeInstance(data: unknown): PackIdentity {
  const json = record(data)
  const base = record(json.baseModLoader)
  const loader = loaderId(text(base.name))
  const installed = record(json.installedModpack)
  return {
    name: text(json.name) ?? text(installed.name) ?? null,
    version: text(record(json.manifest).version) ?? null,
    gameVersion: releaseId(text(base.minecraftVersion) ?? text(json.gameVersion)),
    loader: loader?.loader ?? null,
    loaderVersion: loader?.version ?? null,
    memoryMb:
      typeof json.allocatedMemory === 'number' && json.allocatedMemory >= 256 ? json.allocatedMemory : null,
  }
}

// ─── Prism Launcher and MultiMC ────────────────────────────────────────────────────────────

/** Component uids in `mmc-pack.json`, by what they are. */
const COMPONENTS: Record<string, PackLoader> = {
  'net.minecraftforge': 'forge',
  'net.neoforged': 'neoforge',
  'net.fabricmc.fabric-loader': 'fabric',
  'org.quiltmc.quilt-loader': 'quilt',
}

/** A Prism or MultiMC instance: its components, and its name and memory from `instance.cfg`. */
export function instanceIdentity(components: unknown, cfg: string | undefined): PackIdentity {
  const all = list(record(components).components).map(record)
  const minecraft = all.find((c) => c.uid === 'net.minecraft')
  const loaders = all.flatMap((c) => {
    const loader = COMPONENTS[text(c.uid) ?? '']
    return loader === undefined ? [] : [{ loader, version: text(c.version) ?? null }]
  })
  // Quilt instances can carry Fabric's loader as well; Quilt is what runs them.
  const loader = loaders.find((l) => l.loader === 'quilt') ?? loaders[0]
  const settings = iniValues(cfg ?? '')
  const memory = Number.parseInt(settings.MaxMemAlloc ?? '', 10)
  return {
    name: settings.name ?? null,
    version: null,
    gameVersion: releaseId(text(minecraft?.version)),
    loader: loader?.loader ?? null,
    loaderVersion: loader?.version ?? null,
    // Launchers default this to a value nobody chose; only a real amount says anything.
    memoryMb: Number.isFinite(memory) && memory >= 1024 ? memory : null,
  }
}

function iniValues(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][\w.]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1]) values[match[1]] = match[2] ?? ''
  }
  return values
}

// ─── Packwiz ───────────────────────────────────────────────────────────────────────────────

export interface PackwizPack extends PackIdentity {
  /** The index, relative to `pack.toml`. */
  index: string
}

/** `pack.toml`, decoded. */
export function packwizPack(data: unknown): PackwizPack | null {
  const json = record(data)
  const versions = record(json.versions)
  const index = text(record(json.index).file)
  if (!index) return null
  const loaders = (['neoforge', 'forge', 'quilt', 'fabric'] as const).filter(
    (l) => text(versions[l]) !== undefined,
  )
  const loader = loaders[0] ?? null
  return {
    name: text(json.name) ?? null,
    version: text(json.version) ?? null,
    gameVersion: releaseId(text(versions.minecraft)),
    loader,
    loaderVersion: loader === null ? null : (text(versions[loader]) ?? null),
    memoryMb: null,
    index,
  }
}

export interface PackwizEntry {
  file: string
  /** A `.pw.toml` that describes a file downloaded from elsewhere, rather than the file itself. */
  metafile: boolean
}

/** `index.toml`, decoded: the files of the pack. */
export function packwizIndex(data: unknown): PackwizEntry[] {
  return list(record(data).files)
    .map(record)
    .flatMap((entry) => {
      const file = text(entry.file)
      return file ? [{ file, metafile: entry.metafile === true }] : []
    })
}

export interface PackwizMod {
  name: string
  filename: string
  /** Which side needs it: `both` when it says nothing. */
  side: 'client' | 'server' | 'both'
  /** Where it downloads from, when it says so directly; null for one only CurseForge's API can find. */
  url: string | null
  hash: { format: string; value: string } | null
  /** The Modrinth or CurseForge ids it was added by, which say where it came from. */
  modrinth: { projectId: string; versionId: string } | null
  curseforge: { projectId: number; fileId: number } | null
}

/** One `.pw.toml`, decoded. */
export function packwizMod(data: unknown): PackwizMod | null {
  const json = record(data)
  const filename = text(json.filename)
  if (!filename) return null
  const download = record(json.download)
  const update = record(json.update)
  const modrinth = record(update.modrinth)
  const curseforge = record(update.curseforge)
  const side = text(json.side)
  const url = text(download.url)
  const format = text(download['hash-format'])
  const hash = text(download.hash)
  return {
    name: text(json.name) ?? filename,
    filename,
    side: side === 'client' || side === 'server' ? side : 'both',
    url: url && /^https?:\/\//i.test(url) ? url : null,
    hash: format && hash ? { format: format.toLowerCase(), value: hash.toLowerCase() } : null,
    modrinth:
      text(modrinth['mod-id']) && text(modrinth.version)
        ? { projectId: text(modrinth['mod-id']) ?? '', versionId: text(modrinth.version) ?? '' }
        : null,
    curseforge:
      typeof curseforge['project-id'] === 'number' && typeof curseforge['file-id'] === 'number'
        ? { projectId: curseforge['project-id'], fileId: curseforge['file-id'] }
        : null,
  }
}

// ─── Plain-data helpers ─────────────────────────────────────────────────────────────────────
