/**
 * Checking one release of one of Blockly's own packs (docs/modpack-templates.md § Blockly's own
 * packs): its list resolved on the Minecraft it is named for, held to what it says of players and
 * to open licences, every file fetched and matched, and written as a pack of Blockly's own.
 *
 * It doesn't decide when a release is put together (`queue.ts`), and it doesn't record what it
 * found: it returns it, or throws a refusal, and `ingest.ts` keeps either.
 */
import { join } from 'node:path'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { judgeLicences, type LicenceReview, licenceKind, releaseRef } from '../../domain/mods/curation.ts'
import type { Loader } from '../../domain/revision/revision.ts'
import { INDEX_FILE, isSafePath, PACK_LOADERS, type PackFile } from '../../minecraft/mrpack.ts'
import { LOADER_LABELS } from '../../minecraft/versions.ts'
import type { DeploymentCapabilities } from '../capabilities.ts'
import type { ModPlan } from '../mods/service.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { PackArchives } from '../ports/formats.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { tierFor } from '../setups/service.ts'
import { fetchEach } from './check-downloads.ts'
import { blockedSentence, type Checked, Refused } from './check-outcome.ts'
import { neededByPlayers, type OwnPack } from './own.ts'

/**
 * Everything checking a release of one of Blockly's own packs does (docs/modpack-templates.md
 * § Blockly's own packs), in the order that fails soonest:
 *  1. its list resolves on its Minecraft as creating a server with it would, with what each needs;
 *  2. nothing in it has to be in players' games, so plain Minecraft joins, unless its review says
 *     players install it;
 *  3. every work it installs is judged by its licence as any pack's are, and only open ones pass;
 *  4. every file is fetched from where the catalog publishes it, and matched to the catalog's hash;
 *  5. it is written as a pack of Blockly's own that names each file where its authors publish it,
 *     so servers fetch every mod from there, and Blockly keeps nothing of anyone else's. The same
 *     file is the pack players install, where they do: each file says which side needs it.
 */
export async function checkOwnRelease(
  deps: {
    catalog: Pick<ModCatalog, 'id' | 'licences' | 'filesByHash' | 'packDownloadAllowed'>
    archives: Pick<PackArchives, 'fetchTo' | 'write'>
    capabilities: Pick<DeploymentCapabilities, 'archives'>
    /** Resolves a list of mods exactly as creating a server with them would. */
    resolve: (
      target: { gameVersion: string; loader: Loader },
      wanted: ReadonlyArray<{ projectId: string }>,
    ) => Promise<ModPlan>
    loaderBuilds: LoaderBuilds
  },
  pack: OwnPack,
  version: string,
  gameVersion: string,
  work: string,
): Promise<Checked> {
  const ref = releaseRef({ key: pack.key, version })
  const store = deps.capabilities.archives
  if (store === null)
    throw new Refused('This deployment has nowhere to keep Cubepals’ own packs.', `${ref}: no archive store`)

  // 1. The list, resolved for the Minecraft it is named for.
  const plan = await deps.resolve({ gameVersion, loader: pack.loader }, pack.mods)
  if (plan.kind !== 'ok')
    throw new Refused(
      `Its mods don’t all run on Minecraft ${gameVersion} any more.`,
      `${ref}: ${plan.conflicts.map((conflict) => conflict.mod).join(', ')}`,
    )
  const { mods } = plan

  // 2. Plain Minecraft joins, unless players install it.
  const theirs = neededByPlayers(mods)
  if (theirs.length > 0 && pack.playersInstall !== true)
    throw new Refused(
      `Players would need ${theirs.map((mod) => mod.name).join(', ')} in their own games to join.`,
      `${ref}: ${theirs.map((mod) => `${mod.name} (${mod.environment})`).join(', ')}`,
    )

  // 3. Licences: Blockly's own index, and every work of someone else's that a server installs.
  const projectOf = (mod: PinnedMod) => ('projectId' in mod.source ? mod.source.projectId : '')
  const licences = await deps.catalog.licences([...new Set(mods.map(projectOf))])
  const review: LicenceReview = {
    // The one file of its own is the index Blockly writes, under Blockly's own licence.
    pack: { name: pack.name, project: null, licence: 'AGPL-3.0-only' },
    files: mods.map((mod) => ({
      name: mod.name,
      project: { catalog: deps.catalog.id, projectId: projectOf(mod) },
      licence: licences.get(projectOf(mod))?.licence ?? null,
    })),
  }
  const verdict = judgeLicences(review)
  if (!verdict.mirror.allowed)
    throw new Refused(
      blockedSentence(verdict.mirror.blockers),
      `${ref}: ${JSON.stringify(verdict.mirror.blockers)}`,
    )

  // 4. Every file, from where the catalog publishes it, byte for byte, saying what players need.
  const published = await deps.catalog.filesByHash(mods.map((mod) => mod.artifact.sha512))
  const files: PackFile[] = mods.map((mod) => {
    const match = published.get(mod.artifact.sha512)
    const path = `mods/${mod.artifact.fileName}`
    if (match === undefined || !isSafePath(path))
      throw new Refused(`The catalog doesn’t publish ${mod.name} as it was found.`, `${ref}: ${path}`)
    return {
      path,
      sha1: match.file.sha1,
      sha512: match.file.sha512,
      sizeBytes: match.file.sizeBytes,
      downloads: [match.file.url],
      env: { client: theirs.includes(mod) ? 'required' : CLIENT[mod.environment], server: 'required' },
    }
  })
  const { bytes, hosts } = await fetchEach(deps, ref, files, work, false)

  // 5. The pack itself: its index, with the loader build a server of it starts on.
  const loaderVersion = await deps.loaderBuilds.current(pack.loader, gameVersion)
  if (loaderVersion === null)
    throw new Refused(`${LOADER_LABELS[pack.loader]} has no build for Minecraft ${gameVersion} yet.`, ref)
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: version,
    name: pack.name,
    summary: pack.blurb,
    files: files.map((file) => ({
      path: file.path,
      hashes: { sha1: file.sha1, sha512: file.sha512 },
      env: file.env,
      downloads: file.downloads,
      fileSize: file.sizeBytes,
    })),
    dependencies: { minecraft: gameVersion, [PACK_LOADERS[pack.loader]]: loaderVersion },
  }
  const out = join(work, 'own.mrpack')
  const built = await deps.archives.write(
    out,
    (async function* () {
      yield { name: INDEX_FILE, data: new TextEncoder().encode(JSON.stringify(index, null, 2)) }
    })(),
  )
  const key = await store.ingestFile(out, built.sha512)
  const jars = files.map((file) => ({ path: file.path, sha512: file.sha512, sizeBytes: file.sizeBytes }))
  return {
    distribution: 'upstream',
    pack: {
      catalog: 'blockly',
      projectId: pack.key,
      versionId: version,
      name: pack.name,
      versionLabel: version,
      artifact: {
        ref: { kind: 'stored', key },
        sha512: built.sha512,
        sizeBytes: built.sizeBytes,
        fileName: `${pack.key}-${version}.mrpack`,
      },
      page: null,
      environment: theirs.length > 0 ? 'both' : 'server',
      icon: null,
      curated: { key: pack.key, version },
    },
    facts: {
      gameVersion,
      loader: pack.loader,
      loaderVersion,
      // Sized as the same mods would be on a server of one of the templates.
      tier: tierFor(mods),
      playersNeedIt: theirs.length > 0,
      mods: mods.length,
      jarBytes: jars.reduce((total, jar) => total + jar.sizeBytes, 0),
      notes: [],
      upstream: null,
      checked: { files: files.length, bytes, hosts: [...hosts].sort() },
      code: [],
      licences: [review.pack, ...review.files].map((entry) => ({
        name: entry.name,
        project: entry.project?.projectId ?? null,
        licence: entry.licence,
        kind: licenceKind(entry.licence),
      })),
      // Blockly hands out no one else's bytes, so it owes no notices of its own.
      obligations: [],
      mirrorBlockers: [],
    },
    stored: { sha512: built.sha512, key, sizeBytes: built.sizeBytes },
    contents: {
      sha512: built.sha512,
      name: pack.name,
      versionLabel: version,
      gameVersion,
      loader: pack.loader,
      loaderVersion,
      playersNeedIt: theirs.length > 0,
      jars,
      leftOut: [],
      memoryMb: null,
    },
    forPlayers: [],
  }
}

/** What a mod players can do without asks of their games, as the index tells their launchers. */
const CLIENT = { server: 'unsupported', optional: 'optional', both: 'optional' } as const
