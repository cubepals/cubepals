/**
 * Checking one reviewed release of a catalog pack (docs/modpack-templates.md § Ingestion): that its
 * authors still publish exactly the reviewed bytes, that it opens safely, how a server pins it,
 * what its licences allow, that every file it installs is what it says, and, where it may be
 * copied, Blockly's own copy of it.
 *
 * It doesn't decide which releases are checked (`queue.ts`), and it doesn't record what it found:
 * it returns it, or throws a refusal, and `ingest.ts` keeps either. Blockly's own packs are
 * checked by their own rules (`own-check.ts`).
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CuratedFactsJson } from '@blockly/db'
import {
  type CurationVerdict,
  distributionFor,
  judgeLicences,
  type LicenceReview,
  licenceKind,
  type ReviewedWork,
  releaseRef,
} from '../../domain/mods/curation.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { Loader } from '../../domain/revision/revision.ts'
import type { MemoryTier } from '../../domain/server/size.ts'
import {
  INDEX_FILE,
  PACK_LOADERS,
  type PackFile,
  type PackIndex,
  readIndex,
  serverFiles,
} from '../../minecraft/mrpack.ts'
import { onlyForPlayers } from '../../minecraft/pack-layout.ts'
import { runsAsCode } from '../../minecraft/packs.ts'
import type { DeploymentCapabilities } from '../capabilities.ts'
import { AppError } from '../errors.ts'
import { PACK_LIMITS } from '../packs/build.ts'
import type { PackContents } from '../packs/contents.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import {
  type FileFormats,
  HostileArchive,
  type PackArchive,
  type PackArchives,
  UnreadableFile,
} from '../ports/formats.ts'
import { fetchEach } from './check-downloads.ts'
import { blockedSentence, type Checked, Refused, refusedDownload } from './check-outcome.ts'
import type { CuratedPack, CuratedReleaseSpec } from './packs.ts'

/** A pack as creating a server pins one from its catalog (`SetupService.pinnedPack`). */
export interface PinnedCatalogPack {
  pinned: PinnedModpack
  gameVersion: string
  loader: Loader
  loaderVersion: string | null
  tier: MemoryTier
  notes: string[]
}

/** The index of a pack is small; anything bigger than this isn't one. */
const INDEX_BYTES = 16 * 1024 * 1024

/**
 * Everything checking one release does, in the order that fails soonest:
 *  1. the version its authors publish now is the reviewed one, bytes and all;
 *  2. its file, fetched from there alone, is those bytes;
 *  3. opened as hostile input, its index is read by the format's own rules;
 *  4. it is pinned as creating a server would pin it, and what only players need is left out;
 *  5. every work a server installs is judged by its licence, and the distribution decided;
 *  6. every file a server installs is fetched from a host the catalog allows, and matched to the
 *     hash the pack gives it;
 *  7. where it may be mirrored, it is written again as a pack that downloads nothing, and kept.
 */
export async function checkCatalogRelease(
  deps: {
    catalog: Pick<
      ModCatalog,
      'id' | 'version' | 'project' | 'filesByHash' | 'licences' | 'projectPage' | 'packDownloadAllowed'
    >
    archives: Pick<PackArchives, 'fetchTo' | 'open' | 'write'>
    formats: Pick<FileFormats, 'decode'>
    contents: Pick<PackContents, 'load'>
    capabilities: Pick<DeploymentCapabilities, 'archives'>
    /** Pins a catalog pack exactly as creating a server from it would. */
    pin: (projectId: string, versionId: string) => Promise<PinnedCatalogPack>
  },
  pack: CuratedPack,
  spec: CuratedReleaseSpec,
  work: string,
): Promise<Checked> {
  const ref = releaseRef({ key: pack.key, version: spec.version })
  const allowed = (url: string) => deps.catalog.packDownloadAllowed(url)

  // 1. Provenance: the catalog still publishes exactly what was reviewed, as the reviewed project.
  const version = await deps.catalog.version(spec.versionId)
  if (version === null || version.state === 'absent')
    throw new Refused('Its authors no longer publish this version.', `${ref}: ${spec.versionId} not shown`)
  if (version.projectId !== pack.source.projectId)
    throw new Refused(
      'This version belongs to another project than the one reviewed.',
      `${ref}: ${spec.versionId} belongs to ${version.projectId}`,
    )
  if (version.file.sha512 !== spec.sha512 || version.file.sizeBytes !== spec.sizeBytes)
    throw new Refused(
      'Its authors now publish different bytes under this version than the ones reviewed.',
      `${ref}: published ${version.file.sha512} (${version.file.sizeBytes} bytes)`,
    )
  const project = await deps.catalog.project(pack.source.projectId)
  if (project === null || (project.state !== 'approved' && project.state !== 'archived'))
    throw new Refused('Its project isn’t published any more.', `${ref}: ${project?.state ?? 'absent'}`)
  if (!allowed(version.file.url))
    throw new Refused('It is published somewhere Cubepals doesn’t fetch packs from.', version.file.url)

  // 2. The file itself, from there, byte for byte.
  const upstreamPath = join(work, 'upstream.mrpack')
  const fetched = await deps.archives
    .fetchTo(version.file.url, upstreamPath, spec.sizeBytes, { allowed })
    .catch(refusedDownload(version.file.fileName))
  if (fetched.sha512 !== spec.sha512)
    throw new Refused(
      'The file its authors’ site served isn’t the one reviewed.',
      `${ref}: served ${fetched.sha512} (${fetched.sizeBytes} bytes)`,
    )
  const fetchedAt = new Date()

  // 3. Opened as the hostile input any archive could be, and its index read by its format's rules.
  const archive = await deps.archives.open(upstreamPath, PACK_LIMITS).catch((error: unknown) => {
    if (error instanceof HostileArchive || error instanceof UnreadableFile)
      throw new Refused('Its file isn’t a pack Cubepals can open safely.', `${ref}: ${error.message}`)
    throw error
  })
  try {
    if (!archive.files.some((file) => file.name === INDEX_FILE))
      throw new Refused('It has no Modrinth index.', ref)
    const text = new TextDecoder().decode(await archive.read(INDEX_FILE, INDEX_BYTES))
    const index = readIndex(deps.formats.decode('json', text))
    if ('refused' in index) throw new Refused(index.refused, ref)
    if (index.loader === 'vanilla') throw new Refused('It has no mod loader for a server to run.', ref)

    // 4. Pinned as a server made from the catalog pins it: sides, size, what players need.
    const pinned = await deps.pin(pack.source.projectId, spec.versionId).catch((error: unknown) => {
      if (error instanceof AppError) throw new Refused(error.message, `${ref}: ${error.code}`)
      throw error
    })
    const contents = await deps.contents.load(spec.sha512)
    if (contents === null) throw new Error(`${ref}: its contents were not kept when it was pinned`)
    const forPlayers = [
      ...serverFiles(index)
        .map((file) => file.path)
        .filter(onlyForPlayers),
      ...archive.files
        .map((file) => file.name)
        .filter((name) => /^(server-)?overrides\/.+\.(zip|jar)$/i.test(name) && onlyForPlayers(name)),
    ]
    const leftOut = new Set([...(pinned.pinned.leaveOut ?? []), ...forPlayers])
    const installed = serverFiles(index).filter((file) => !leftOut.has(file.path))
    const carried = archive.files.filter(
      (file) =>
        /^(server-)?overrides\//.test(file.name) && !leftOut.has(file.name) && !onlyForPlayers(file.name),
    )

    // 5. Licences: the pack's own, and every work of someone else's that a server installs.
    const review = await licenceReview(deps.catalog, pack, installed, await carriedWorks(archive, carried))
    const verdict = judgeLicences(review, pack.readings, pack.permissions)
    const decided = distributionFor(verdict, pack.distribution, deps.capabilities.archives !== null)
    if ('refused' in decided)
      throw new Refused(blockedSentence(decided.refused), `${ref}: ${JSON.stringify(decided.refused)}`)
    const mirroring = decided.distribution === 'mirror'

    // 6. Every file a server installs, fetched from where the pack says, matched to its hash.
    const { kept, bytes, hosts } = await fetchEach(deps, ref, installed, work, mirroring)

    const kindOf = (licence: string | null) =>
      pack.readings.find((reading) => reading.licence === licence)?.reads ?? licenceKind(licence)
    const facts: CuratedFactsJson = {
      gameVersion: pinned.gameVersion,
      loader: pinned.loader,
      loaderVersion: pinned.loaderVersion,
      tier: pinned.tier,
      // As the product says it everywhere else: by the catalog's word on where the pack runs,
      // since packs' own marks aren't to be trusted (SkyBlock Plus marks every mod for players).
      playersNeedIt: pinned.pinned.environment === 'both',
      mods: contents.jars.length,
      jarBytes: contents.jars.reduce((total, jar) => total + jar.sizeBytes, 0),
      notes: pinned.notes,
      upstream: {
        catalog: pack.source.catalog,
        projectId: pack.source.projectId,
        versionId: spec.versionId,
        sha512: spec.sha512,
        sizeBytes: spec.sizeBytes,
        fileName: version.file.fileName,
        fetchedAt: fetchedAt.toISOString(),
      },
      checked: { files: installed.length, bytes, hosts: [...hosts].sort() },
      code: carried.map((file) => file.name).filter(runsAsCode),
      licences: [review.pack, ...review.files].map((entry) => ({
        name: entry.name,
        project: entry.project?.projectId ?? null,
        licence: entry.licence,
        kind: kindOf(entry.licence),
      })),
      obligations: mirroring ? verdict.mirror.obligations : [],
      mirrorBlockers: verdict.mirror.blockers,
    }
    const upstream: PinnedModpack = {
      ...pinned.pinned,
      ...(leftOut.size > 0 ? { leaveOut: [...leftOut] } : {}),
      curated: { key: pack.key, version: spec.version },
    }
    if (!mirroring)
      return { distribution: 'upstream', pack: upstream, facts, stored: null, contents: null, forPlayers }

    // 7. Blockly's own copy: everything a server installs carried inside, nothing to download.
    const store = deps.capabilities.archives
    if (store === null) throw new Error(`${ref}: a mirror was decided without a store`)
    const built = await deps.archives.write(
      join(work, 'mirror.mrpack'),
      mirrorEntries({
        index,
        installed,
        carried,
        kept,
        archive,
        summary: `Cubepals' copy of ${pack.name} ${spec.version}, for servers.`,
        notices: noticesOf(pack, spec, review, verdict, (projectId) => deps.catalog.projectPage(projectId)),
      }),
    )
    const key = await store.ingestFile(join(work, 'mirror.mrpack'), built.sha512)
    const { leaveOut: _nothingToLeaveOut, ...mirrored } = upstream
    return {
      distribution: 'mirror',
      // Nothing it leaves out is in the copy, so nothing is left out as it installs.
      pack: {
        ...mirrored,
        artifact: {
          ref: { kind: 'stored', key },
          sha512: built.sha512,
          sizeBytes: built.sizeBytes,
          fileName: `${pack.key}-${spec.version}.mrpack`,
        },
        publishedFile: version.file.url,
      },
      facts,
      stored: { sha512: built.sha512, key, sizeBytes: built.sizeBytes },
      contents: {
        ...contents,
        sha512: built.sha512,
        leftOut: [
          ...contents.leftOut,
          ...forPlayers
            .filter((path) => !contents.leftOut.some((entry) => entry.path === path))
            .map((path) => ({ path, why: 'players' as const })),
        ],
      },
      forPlayers,
    }
  } finally {
    await archive.close()
  }
}

/** Who made each work a server installs, and the licence its publisher declares for it. */
async function licenceReview(
  catalog: Pick<ModCatalog, 'id' | 'filesByHash' | 'licences'>,
  pack: CuratedPack,
  installed: readonly PackFile[],
  carried: ReadonlyArray<{ name: string; sha512: string }>,
): Promise<LicenceReview> {
  const matches = await catalog.filesByHash([
    ...installed.map((file) => file.sha512),
    ...carried.map((file) => file.sha512),
  ])
  const projects = [...matches.values()].map((match) => match.version.projectId)
  const licences = await catalog.licences([...new Set([pack.source.projectId, ...projects])])
  const own: ReviewedWork = {
    name: pack.name,
    project: { catalog: pack.source.catalog, projectId: pack.source.projectId },
    licence: licences.get(pack.source.projectId)?.licence ?? null,
  }
  const workOf = (sha512: string, path: string): ReviewedWork => {
    const projectId = matches.get(sha512)?.version.projectId
    const known = projectId === undefined ? undefined : licences.get(projectId)
    // What the review found to be the pack's own authors' work is theirs, under their licence.
    if (projectId === undefined && pack.authored.includes(path)) return { ...own, name: path }
    if (projectId === undefined || known === undefined) return { name: path, project: null, licence: null }
    return { name: known.name, project: { catalog: catalog.id, projectId }, licence: known.licence }
  }
  return {
    pack: own,
    files: [
      ...installed.map((file) => workOf(file.sha512, file.path)),
      ...carried.map((file) => workOf(file.sha512, file.name)),
    ],
  }
}

/**
 * The jars and archives a pack carries inside itself, each hashed so the catalog that publishes
 * it, if one does, can say whose it is: a pack's author can licence their own files, never someone
 * else's mod they carry.
 */
async function carriedWorks(
  archive: PackArchive,
  carried: ReadonlyArray<{ name: string }>,
): Promise<Array<{ name: string; sha512: string }>> {
  const works: Array<{ name: string; sha512: string }> = []
  for (const file of carried) {
    if (!/\.(jar|zip)$/i.test(file.name)) continue
    const bytes = await archive.read(file.name, PACK_LIMITS.maxFileBytes)
    works.push({ name: file.name, sha512: createHash('sha512').update(bytes).digest('hex') })
  }
  return works
}

/**
 * The pack written again as Blockly's copy: the same index with nothing left to download, every
 * file a server installs carried where the image puts it, what the pack carries for servers as it
 * carried it, and what the copy owes each work written beside them. Where the pack carries a file
 * over one its index lists, the carried one is what a server ends up with, so it is the one kept.
 */
async function* mirrorEntries(input: {
  index: PackIndex
  installed: readonly PackFile[]
  carried: ReadonlyArray<{ name: string }>
  kept: ReadonlyMap<string, string>
  archive: PackArchive
  summary: string
  notices: string
}): AsyncIterable<{ name: string; data: Uint8Array | ReadableStream<Uint8Array> }> {
  const { index } = input
  const loader = index.loader === 'vanilla' ? null : PACK_LOADERS[index.loader]
  const manifest = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: index.versionId,
    name: index.name,
    summary: input.summary,
    files: [],
    dependencies: {
      minecraft: index.gameVersion,
      ...(loader === null ? {} : { [loader]: index.loaderVersion }),
    },
  }
  const encode = (text: string) => new TextEncoder().encode(text)
  yield { name: INDEX_FILE, data: encode(JSON.stringify(manifest, null, 2)) }
  // Beside the index, never under overrides: the notices travel with the copy, not onto servers.
  yield { name: 'blockly-notices.txt', data: encode(input.notices) }
  const carriedPaths = new Set(input.carried.map((file) => file.name.replace(/^(server-)?overrides\//, '')))
  for (const file of input.installed) {
    if (carriedPaths.has(file.path)) continue
    const path = input.kept.get(file.path)
    if (path === undefined) throw new Error(`${file.path} was never fetched`)
    // One file at a time, as the writer asks for it: a mod is megabytes, never the whole pack.
    yield { name: `overrides/${file.path}`, data: new Uint8Array(await readFile(path)) }
  }
  for (const file of input.carried) yield { name: file.name, data: input.archive.stream(file.name) }
}

/**
 * The notices Blockly's copy carries (docs/modpack-templates.md § Obligations): every work in it,
 * its licence, and where its source is, since copyleft asks that the source go with every copy.
 */
function noticesOf(
  pack: CuratedPack,
  spec: CuratedReleaseSpec,
  review: LicenceReview,
  verdict: CurationVerdict,
  page: (projectId: string) => string,
): string {
  const lines = [
    `${pack.name} ${spec.version}, by ${pack.authors}.`,
    'Cubepals made this copy for its own servers, file for file as its authors published them.',
    'Every work in it keeps its own licence, and its authors own it.',
    '',
  ]
  for (const work of [review.pack, ...review.files]) {
    const owes = verdict.mirror.obligations.find((owed) => owed.name === work.name)?.owes ?? []
    const source =
      owes.includes('source') && work.project !== null ? ` Source: ${page(work.project.projectId)}` : ''
    lines.push(`- ${work.name}: ${work.licence ?? 'no licence declared'}.${source}`)
  }
  return `${lines.join('\n')}\n`
}
