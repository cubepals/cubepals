import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { PackImportJson, PackJarJson, PackLeftOutJson } from '@blockly/db'
import type { Loader } from '../../domain/revision/revision.ts'
import {
  INDEX_FILE,
  isJar,
  OVERRIDES,
  PACK_LOADERS,
  type PackFile,
  type PackLoader,
  readIndex,
  SERVER_OVERRIDES,
} from '../../minecraft/mrpack.ts'
import {
  jarSide,
  namedReleases,
  oldEnough,
  packNameOf,
  packNotes,
  packTierFor,
  runsOn,
  someNames,
} from '../../minecraft/pack-build.ts'
import { type Detected, detect, insideAny, placeOf, worldFolders } from '../../minecraft/pack-layout.ts'
import {
  curseForgeExport,
  curseForgeInstance,
  instanceIdentity,
  type PackIdentity,
  packwizIndex,
  packwizMod,
  packwizPack,
} from '../../minecraft/pack-manifests.ts'
import { startFilesWanted, startInfo } from '../../minecraft/server-pack.ts'
import { fits, type ModMetadata } from '../../minecraft/uploads.ts'
import { LOADER_LABELS, offeredVersions } from '../../minecraft/versions.ts'
import type { CatalogFileMatch, ModCatalog } from '../ports/catalog.ts'
import type { CurseForge } from '../ports/curseforge.ts'
import {
  type FileFormats,
  HostileArchive,
  type PackArchive,
  type PackArchives,
  UnreadableFile,
} from '../ports/formats.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { jarMetadata } from './jars.ts'

/**
 * Building a pack Blockly can install from one someone uploaded (docs/modpack-system.md): the
 * file is read as hostile input, recognised, and written again as a Modrinth pack, the one shape
 * the image installs every pack from. Mods the catalog publishes are listed by their catalog
 * download, where their authors count them; the rest travel inside the pack, as the owner's own
 * files for the owner's own server. Nothing in it is run here.
 */

/** Limits on what an upload may hold once opened (the archive research's, 2026-09-26). */
export const PACK_LIMITS = {
  maxFiles: 50_000,
  maxTotalBytes: 4 * 1024 ** 3,
  maxFileBytes: 512 * 1024 ** 2,
}
/** The small files read to recognise a pack: an index, a manifest, a script. */
const TEXT_BYTES = 8 * 1024 * 1024

/** What building found: a pack to store, a catalog pack the upload turned out to be, or a refusal. */
export type BuildResult =
  | {
      kind: 'built'
      /** The pack written, on this machine. */
      path: string
      sha512: string
      sizeBytes: number
      summary: PackImportJson
      contents: BuiltContents
    }
  | { kind: 'catalog'; projectId: string; versionId: string }
  | { kind: 'refused'; message: string; detail: string }

/** What a built pack holds, as `pack_contents` keeps it. */
export interface BuiltContents {
  name: string
  versionLabel: string
  gameVersion: string
  loader: Loader
  loaderVersion: string | null
  playersNeedIt: boolean
  jars: PackJarJson[]
  leftOut: PackLeftOutJson[]
  memoryMb: number | null
}

class Refused extends Error {
  readonly sentence: string
  readonly detail: string
  constructor(sentence: string, detail = sentence) {
    super(sentence)
    this.sentence = sentence
    this.detail = detail
  }
}

/** A file from the upload, and where it goes on the server. */
interface Placement {
  from: string
  to: string
  /** `server-overrides/` for what a Modrinth pack keeps for servers alone. */
  layer: 'overrides' | 'server-overrides'
}

/** Everything a format's reader works out, before the jars are looked at. */
interface Plan {
  format: Detected['format']
  identity: Omit<PackIdentity, 'version'> & { version: string | null }
  place: Placement[]
  /** Files an uploaded Modrinth pack lists with their downloads. */
  listed: PackFile[]
  leftOut: PackLeftOutJson[]
  worlds: number
  /** `-D` properties the pack starts with. */
  javaProperties: Record<string, string>
}

export class PackBuilder {
  readonly #archives: PackArchives
  readonly #formats: FileFormats
  readonly #catalog: ModCatalog
  readonly #curseforge: CurseForge
  readonly #builds: LoaderBuilds

  constructor(deps: {
    archives: PackArchives
    formats: FileFormats
    catalog: ModCatalog
    curseforge: CurseForge
    loaderBuilds: LoaderBuilds
  }) {
    this.#archives = deps.archives
    this.#formats = deps.formats
    this.#catalog = deps.catalog
    this.#curseforge = deps.curseforge
    this.#builds = deps.loaderBuilds
  }

  /**
   * Builds from the upload at `path`, writing the pack into `workDir`. `sha512` is the upload's:
   * a Modrinth pack downloaded from Modrinth is recognised as the published pack it is.
   */
  async build(
    upload: { path: string; fileName: string; sha512: string },
    workDir: string,
  ): Promise<BuildResult> {
    try {
      if (/\.mrpack$/i.test(upload.fileName)) {
        const published = (await this.#catalog.filesByHash([upload.sha512])).get(upload.sha512)
        if (published !== undefined)
          return {
            kind: 'catalog',
            projectId: published.version.projectId,
            versionId: published.version.versionId,
          }
      }
      return await this.#build(upload.path, upload.fileName, workDir, 0)
    } catch (error) {
      if (error instanceof Refused) return { kind: 'refused', message: error.sentence, detail: error.detail }
      if (error instanceof HostileArchive)
        return {
          kind: 'refused',
          message:
            error.reason === 'too_large' || error.reason === 'too_many_files'
              ? 'This pack is bigger than Cubepals takes.'
              : 'This file can’t be opened safely, so Cubepals won’t use it.',
          detail: `${error.reason}: ${error.message}`,
        }
      if (error instanceof UnreadableFile)
        return {
          kind: 'refused',
          message: 'This file isn’t a zip or a Modrinth pack Cubepals can open.',
          detail: error.message,
        }
      throw error
    }
  }

  async #build(path: string, fileName: string, workDir: string, depth: number): Promise<BuildResult> {
    const archive = await this.#archives.open(path, PACK_LIMITS)
    try {
      const names = archive.files.map((file) => file.name)
      const detected = detect(names)
      if (detected === null) {
        // A download that wraps the pack in one more zip: opened once, never deeper.
        const inner = names.filter((name) => !/(^|\/)(readme|license)[^/]*$/i.test(name))
        const only = inner.length === 1 ? inner[0] : undefined
        if (depth === 0 && only !== undefined && /\.(zip|mrpack)$/i.test(only)) {
          const nested = join(workDir, 'nested.zip')
          await pipeline(
            Readable.fromWeb(archive.stream(only) as unknown as WebReadableStream<Uint8Array>),
            createWriteStream(nested),
          )
          return await this.#build(nested, only.split('/').pop() ?? only, workDir, depth + 1)
        }
        throw new Refused(
          'This file doesn’t hold a modpack Cubepals can build a server from.',
          `no pack found among ${names.length} files`,
        )
      }
      const plan = await this.#plan(archive, detected, fileName)
      return await this.#finish(archive, plan, fileName, workDir)
    } finally {
      await archive.close()
    }
  }

  // ─── Each format ─────────────────────────────────────────────────────────────────────────

  async #plan(archive: PackArchive, detected: Detected, fileName: string): Promise<Plan> {
    const root = detected.root
    const text = async (name: string) =>
      new TextDecoder().decode(await archive.read(`${root}${name}`, TEXT_BYTES))
    const has = (name: string) => archive.files.some((file) => file.name === `${root}${name}`)
    const json = async (name: string) => this.#formats.decode('json', await text(name))
    const empty = {
      name: null,
      version: null,
      gameVersion: null,
      loader: null,
      loaderVersion: null,
      memoryMb: null,
    }

    switch (detected.format) {
      case 'mrpack': {
        const index = readIndex(await json(INDEX_FILE))
        if ('refused' in index) throw new Refused(index.refused)
        if (index.loader === 'vanilla')
          throw new Refused('This pack has no mod loader, so there’s nothing for a server to run.')
        const place = [
          ...this.#layer(archive, `${root}${OVERRIDES}`, 'overrides'),
          ...this.#layer(archive, `${root}${SERVER_OVERRIDES}`, 'server-overrides'),
        ]
        return {
          format: 'mrpack',
          identity: {
            name: index.name,
            version: index.versionId || null,
            gameVersion: index.gameVersion,
            loader: index.loader,
            loaderVersion: index.loaderVersion,
            memoryMb: null,
          },
          ...this.#placed(place),
          listed: index.files.filter((file) => file.env.server !== 'unsupported'),
          javaProperties: {},
        }
      }
      case 'curseforge': {
        const manifest = curseForgeExport(await json('manifest.json'))
        if (manifest === null)
          throw new Refused(
            'This file doesn’t hold a modpack Cubepals can build a server from.',
            'manifest.json is not a modpack manifest',
          )
        if (manifest.files.length > 0 && this.#curseforge.files === null)
          throw new Refused(
            'This CurseForge pack lists its mods on CurseForge instead of holding them, and Cubepals can’t download from CurseForge. On the pack’s CurseForge page, download its server pack from Files and drop that here instead.',
            `curseforge export with ${manifest.files.length} referenced files; no CurseForge permission`,
          )
        const place = this.#layer(archive, `${root}${manifest.overrides}/`, 'overrides')
        return {
          format: 'curseforge',
          identity: manifest,
          ...this.#placed(place),
          listed: [],
          javaProperties: {},
        }
      }
      case 'packwiz':
        return await this.#packwiz(archive, root, text)
      case 'instance': {
        const identity = has('minecraftinstance.json')
          ? curseForgeInstance(await json('minecraftinstance.json'))
          : instanceIdentity(
              has('mmc-pack.json') ? await json('mmc-pack.json') : {},
              has('instance.cfg') ? await text('instance.cfg') : undefined,
            )
        const place = this.#layer(archive, `${root}${detected.game}`, 'overrides')
        return {
          format: 'instance',
          identity: { ...identity, name: identity.name ?? stem(fileName) },
          ...this.#placed(place),
          listed: [],
          javaProperties: {},
        }
      }
      case 'server': {
        const top = archive.files.map((file) => file.name.slice(root.length)).filter((name) => name !== '')
        const texts: Record<string, string> = {}
        for (const name of top.filter(startFilesWanted)) texts[name] = await text(name)
        const starter = texts['server-setup-config.yaml']
        const info = startInfo({
          names: top,
          texts,
          ...(starter === undefined ? {} : { serverStarter: this.#formats.decode('yaml', starter) }),
        })
        if (info.downloadsOwnMods && !top.some((name) => name.startsWith('mods/') && isJar(name)))
          throw new Refused(
            'This server pack downloads its mods from CurseForge as it starts, which Cubepals can’t do. Drop the pack’s full server files, with its mods folder, instead.',
            'ServerStarter pack without a mods folder',
          )
        const place = this.#layer(archive, root, 'overrides')
        return {
          format: 'server',
          identity: { ...empty, ...info, ...packNameOf(fileName) },
          ...this.#placed(place),
          listed: [],
          javaProperties: info.javaProperties,
        }
      }
      case 'mods': {
        const base = `${root}${detected.game}`
        const jarsAtTop = archive.files.every((file) => /^[^/]+\.jar$/i.test(file.name.slice(base.length)))
        const place = jarsAtTop
          ? archive.files.map((file) => ({
              from: file.name,
              to: `mods/${file.name.slice(base.length)}`,
              layer: 'overrides' as const,
            }))
          : this.#layer(archive, base, 'overrides')
        return {
          format: 'mods',
          identity: { ...empty, ...packNameOf(fileName) },
          ...this.#placed(place),
          listed: [],
          javaProperties: {},
        }
      }
    }
  }

  /** Every file under `prefix`, placed as the layout says, or left out with why. */
  #layer(
    archive: PackArchive,
    prefix: string,
    layer: Placement['layer'],
  ): Array<Placement | PackLeftOutJson> {
    const inside = archive.files.filter(
      (file) => file.name.startsWith(prefix) && file.name.length > prefix.length,
    )
    const relative = inside.map((file) => file.name.slice(prefix.length))
    const worlds = worldFolders(relative)
    return inside.map((file, i) => {
      const path = relative[i] ?? ''
      if (insideAny(path, worlds)) return { path, why: 'world' as const }
      const place = placeOf(path)
      return 'leftOut' in place ? { path, why: place.leftOut } : { from: file.name, to: place.path, layer }
    })
  }

  #placed(all: Array<Placement | PackLeftOutJson>): Pick<Plan, 'place' | 'leftOut' | 'worlds'> {
    const place = all.filter((entry): entry is Placement => 'from' in entry)
    const leftOut = all.filter((entry): entry is PackLeftOutJson => 'why' in entry)
    return {
      place,
      leftOut,
      worlds:
        worldFolders(leftOut.filter((l) => l.why === 'world').map((l) => l.path)).length ||
        (leftOut.some((l) => l.why === 'world') ? 1 : 0),
    }
  }

  /**
   * A Packwiz pack, zipped: its index lists every file, and each mod's `.pw.toml` says where it
   * downloads from. Mods it takes from Modrinth are listed by their catalog download; a mod whose
   * only source is CurseForge can't be fetched, which refuses the pack.
   */
  async #packwiz(
    _archive: PackArchive,
    root: string,
    text: (name: string) => Promise<string>,
  ): Promise<Plan> {
    const pack = packwizPack(this.#formats.decode('toml', await text('pack.toml')))
    if (pack === null) throw new Refused('This Packwiz pack has no index, so Cubepals can’t read it.')
    const indexDir = pack.index.includes('/') ? pack.index.slice(0, pack.index.lastIndexOf('/') + 1) : ''
    const entries = packwizIndex(this.#formats.decode('toml', await text(pack.index)))
    const place: Placement[] = []
    const leftOut: PackLeftOutJson[] = []
    const fromModrinth: Array<{ path: string; versionId: string; side: 'server' | 'both' }> = []
    for (const entry of entries) {
      const path = `${indexDir}${entry.file}`
      if (!entry.metafile) {
        const placed = placeOf(entry.file)
        if ('leftOut' in placed) leftOut.push({ path: entry.file, why: placed.leftOut })
        else place.push({ from: `${root}${path}`, to: placed.path, layer: 'overrides' })
        continue
      }
      const mod = packwizMod(this.#formats.decode('toml', await text(path)))
      if (mod === null) continue
      const folder = entry.file.includes('/') ? entry.file.slice(0, entry.file.lastIndexOf('/') + 1) : ''
      if (mod.side === 'client') {
        leftOut.push({ path: `${folder}${mod.filename}`, why: 'players' })
        continue
      }
      if (mod.modrinth === null)
        throw new Refused(
          mod.curseforge !== null
            ? 'This pack gets some of its mods from CurseForge, which Cubepals can’t download from.'
            : 'This pack downloads some of its mods from places Cubepals can’t check.',
          `packwiz entry ${mod.name} has no Modrinth source`,
        )
      fromModrinth.push({
        path: `${folder}${mod.filename}`,
        versionId: mod.modrinth.versionId,
        side: mod.side,
      })
    }
    const versions = await this.#catalog.versionsByIds(fromModrinth.map((m) => m.versionId))
    const matches = await this.#catalog.filesByHash([...versions.values()].map((v) => v.file.sha512))
    const listed: PackFile[] = fromModrinth.map((mod) => {
      const version = versions.get(mod.versionId)
      const match = version && matches.get(version.file.sha512)
      if (!match)
        throw new Refused(
          'Some of this pack’s mods aren’t on Modrinth any more.',
          `packwiz version ${mod.versionId} not found`,
        )
      return {
        path: mod.path,
        sha1: match.file.sha1,
        sha512: match.file.sha512,
        sizeBytes: match.file.sizeBytes,
        downloads: [match.file.url],
        env: { client: 'required', server: 'required' },
      }
    })
    return {
      format: 'packwiz',
      identity: { ...pack, version: pack.version },
      place,
      leftOut,
      worlds: 0,
      listed,
      javaProperties: {},
    }
  }

  // ─── Jars, identity and the pack written ────────────────────────────────────────────────

  async #finish(archive: PackArchive, plan: Plan, fileName: string, workDir: string): Promise<BuildResult> {
    // Every jar headed for the mods folder is hashed once and read for what it says of itself.
    const jars = plan.place.filter((p) => p.to.startsWith('mods/') && isJar(p.to))
    const read = new Map<
      string,
      { sha1: string; sha512: string; size: number; metadata: ModMetadata | null }
    >()
    for (const jar of jars) {
      const bytes = await archive.read(jar.from, PACK_LIMITS.maxFileBytes)
      read.set(jar.from, {
        sha1: createHash('sha1').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('hex'),
        size: bytes.length,
        metadata: jarMetadata(this.#formats, bytes),
      })
    }
    const published = await this.#catalog.filesByHash([
      ...[...read.values()].map((jar) => jar.sha512),
      ...plan.listed.map((file) => file.sha512),
    ])

    const leftOut = [...plan.leftOut]
    const leftForPlayers: string[] = []
    const files: PackFile[] = []
    const embedded: Placement[] = []
    const kept: Array<{
      path: string
      sha512: string
      size: number
      side: string
      metadata: ModMetadata | null
    }> = []

    // What the pack lists already: each download held to the catalog's rule, each side checked
    // against the catalog's record of that file.
    for (const file of plan.listed) {
      const match = published.get(file.sha512)
      const side = jarSide({ catalog: match?.version.environment ?? null })
      if (isJar(file.path) && side === 'client') {
        leftOut.push({ path: file.path, why: 'players' })
        leftForPlayers.push(file.path)
        continue
      }
      const downloads = match
        ? [match.file.url]
        : file.downloads.filter((url) => this.#catalog.packDownloadAllowed(url))
      if (downloads.length === 0)
        throw new Refused(
          'This pack downloads some of its files from sites Cubepals doesn’t download packs from.',
          `${file.path}: ${file.downloads.join(' ')}`,
        )
      files.push({ ...file, downloads })
      if (isJar(file.path))
        kept.push({ path: file.path, sha512: file.sha512, size: file.sizeBytes, side, metadata: null })
    }

    for (const jar of jars) {
      const facts = read.get(jar.from)
      if (facts === undefined) continue
      const match: CatalogFileMatch | undefined = published.get(facts.sha512)
      const side = jarSide({ catalog: match?.version.environment ?? null, metadata: facts.metadata })
      if (side === 'client') {
        leftOut.push({ path: jar.to, why: 'players' })
        leftForPlayers.push(jar.to)
        continue
      }
      kept.push({ path: jar.to, sha512: facts.sha512, size: facts.size, side, metadata: facts.metadata })
      if (match !== undefined && jar.layer === 'overrides')
        files.push({
          path: jar.to,
          sha1: facts.sha1,
          sha512: facts.sha512,
          sizeBytes: facts.size,
          downloads: [match.file.url],
          env: { client: side === 'server' ? 'optional' : 'required', server: 'required' },
        })
      else embedded.push(jar)
    }

    const identity = await this.#identity(
      plan,
      kept.map((jar) => jar.metadata).filter((m): m is ModMetadata => m !== null),
    )
    if (kept.length === 0)
      throw new Refused('This pack holds no mods a server runs, so there’s nothing to build a server from.')

    const others = plan.place.filter((p) => !(p.to.startsWith('mods/') && isJar(p.to)))
    const loaderKey = PACK_LOADERS[identity.loader]
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: identity.version,
      name: identity.name,
      summary: `Built by Cubepals from ${fileName}`,
      files: files.map((file) => ({
        path: file.path,
        hashes: { sha1: file.sha1, sha512: file.sha512 },
        env: file.env,
        downloads: file.downloads,
        fileSize: file.sizeBytes,
      })),
      dependencies: { minecraft: identity.gameVersion, [loaderKey]: identity.loaderVersion },
    }
    const out = join(workDir, 'built.mrpack')
    await rm(out, { force: true })
    const written = await this.#archives.write(out, entries(archive, index, [...embedded, ...others]))

    const jarBytes = kept.reduce((total, jar) => total + jar.size, 0)
    const tier = packTierFor({ memoryMb: identity.memoryMb, mods: kept.length, jarBytes })
    const playersNeedIt = kept.some((jar) => jar.side === 'both')
    const notes = [
      ...packNotes({ leftOutForPlayers: leftForPlayers, worlds: plan.worlds, memoryMb: identity.memoryMb }),
      ...(identity.note === null ? [] : [identity.note]),
    ]
    return {
      kind: 'built',
      path: out,
      sha512: written.sha512,
      sizeBytes: written.sizeBytes,
      summary: {
        format: plan.format,
        name: identity.name,
        versionLabel: identity.version,
        gameVersion: identity.gameVersion,
        loader: identity.loader,
        loaderVersion: identity.loaderVersion,
        tier,
        playersNeedIt,
        mods: kept.length,
        catalog: null,
        ...(Object.keys(plan.javaProperties).length > 0 ? { javaProperties: plan.javaProperties } : {}),
        notes,
      },
      contents: {
        name: identity.name,
        versionLabel: identity.version,
        gameVersion: identity.gameVersion,
        loader: identity.loader,
        loaderVersion: identity.loaderVersion,
        playersNeedIt,
        jars: kept.map((jar) => ({ path: jar.path, sha512: jar.sha512, sizeBytes: jar.size })),
        leftOut,
        memoryMb: identity.memoryMb,
      },
    }
  }

  /**
   * What the pack runs on: what it says, and for what it leaves unsaid, what its mods say, with
   * the loader's current build where no build is named.
   */
  async #identity(plan: Plan, mods: readonly ModMetadata[]) {
    let { gameVersion, loader, loaderVersion } = plan.identity
    if (gameVersion === null || loader === null) {
      const candidates = [...offeredVersions().map((v) => v.id), ...namedReleases(mods)]
      const inferred = runsOn(mods, candidates)
      if ('refused' in inferred)
        throw new Refused(
          mods.length === 0
            ? 'This pack doesn’t say which Minecraft or mod loader it runs on, so Cubepals can’t build a server from it.'
            : inferred.refused,
        )
      gameVersion ??= inferred.gameVersion
      loader ??= inferred.loader
    }
    if (!oldEnough(gameVersion))
      throw new Refused(`This pack is for Minecraft ${gameVersion}, older than Cubepals runs.`)
    const named = loaderVersion !== null
    if (loaderVersion === null) {
      loaderVersion = await this.#builds.current(loader, gameVersion).catch(() => null)
      if (loaderVersion === null)
        throw new Refused(
          `Cubepals couldn’t find ${LOADER_LABELS[loader]} for Minecraft ${gameVersion} to run this pack on.`,
        )
    }
    // A pack naming an older loader build than its own mods accept can't start as it is. The build
    // is Blockly's to pick, so the current one is used when every mod accepts it, and said.
    const refusing = (build: string) => mods.filter((mod) => !fits(mod.loaderVersions ?? [], build))
    const unmet = refusing(loaderVersion)
    let note: string | null = null
    if (unmet.length > 0) {
      const current = named ? await this.#builds.current(loader, gameVersion).catch(() => null) : null
      if (current === null || refusing(current).length > 0)
        throw new Refused(
          `${someNames(unmet.map((mod) => mod.name))} ${unmet.length === 1 ? 'needs' : 'need'} a version of ${LOADER_LABELS[loader]} Cubepals can’t run on Minecraft ${gameVersion}.`,
        )
      note = `Cubepals runs it on ${LOADER_LABELS[loader]} ${current}: ${someNames(unmet.map((mod) => mod.name))} ${unmet.length === 1 ? 'needs' : 'need'} a newer one than the pack names.`
      loaderVersion = current
    }
    return {
      name: plan.identity.name ?? 'A modpack',
      version: plan.identity.version ?? '',
      gameVersion,
      loader: loader as PackLoader,
      loaderVersion,
      memoryMb: plan.identity.memoryMb,
      note,
    }
  }
}

/** The built pack's entries, in order: its index, then every file it carries. */
async function* entries(
  archive: PackArchive,
  index: unknown,
  place: readonly Placement[],
): AsyncIterable<{ name: string; data: Uint8Array | ReadableStream<Uint8Array> }> {
  yield { name: INDEX_FILE, data: new TextEncoder().encode(JSON.stringify(index, null, 2)) }
  for (const file of place) yield { name: `${file.layer}/${file.to}`, data: archive.stream(file.from) }
}

/** A file's name without its folder and extension, for a pack that names itself nothing better. */
function stem(fileName: string): string {
  return (
    (fileName.split('/').pop() ?? fileName)
      .replace(/\.(zip|mrpack)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || 'A modpack'
  )
}
