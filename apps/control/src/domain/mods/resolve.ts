// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { DATAPACK, type PinnedMod } from './artifact.ts'
import { type CatalogDependency, type CatalogProject, type CatalogVersion, catalogOfId } from './catalog.ts'
import { type Held, heldBack, JarHold, type JarNeeds, type JarTarget } from './jar-holds.ts'

/**
 * Which versions a server runs for the mods its owner wants, with everything they require
 * (docs/architecture.md §15.5). Pure: the catalog's answers come in as data. When they aren't
 * enough, the result says what else to fetch, and the caller asks again with more; each call
 * starts from scratch, so the answer depends only on the data.
 */

export interface ResolveRequest {
  /**
   * The catalog a wanted mod comes from, pinned as its source, unless its id names another
   * (`catalogOfId`): a Paper server's plugins can come from Modrinth and Hangar at once.
   */
  catalog: string
  /**
   * `java` is the Java the server's image runs for the release (`minecraft/versions.ts`): a version
   * whose jar asks for a newer one never fits, whatever the catalog lists. Absent: not checked.
   */
  target: { gameVersion: string; loaders: readonly string[]; java?: number }
  /** Every catalog mod the owner wants, by project, and a version where they chose one. */
  wanted: ReadonlyArray<{ projectId: string; versionId?: string | undefined }>
  /**
   * The server's mods now. A version that still fits is kept, so adding one mod never moves
   * another; uploads are carried over as they are.
   */
  current: readonly PinnedMod[]
  /** Projects to move to their newest fitting version. */
  upgrade: ReadonlySet<string> | 'all'
  /**
   * Whether a version runs on a server, and whether players need it too, from the environment it
   * declares and the loaders it is published for.
   */
  environment: (declared: string, loaders: readonly string[]) => 'server' | 'optional' | 'both' | null
  /**
   * Exact versions Cubepals ran on this target although the catalog doesn't list them for it
   * (`app/curation/tested.ts`). Each counts as fitting; another version of the same project doesn't,
   * and one is picked only where nothing the catalog lists fits.
   */
  tested?: ReadonlyArray<{ projectId: string; versionId: string }>
  /**
   * The project that provides a mod id a jar's own metadata requires, null where none is known.
   * Given where the server's loader stops on a jar missing a mod it requires, which a catalog may not
   * list (`FabricMod`): each is added, and a plan that still lacks one is refused. Absent: what a
   * jar's metadata requires isn't weighed.
   */
  providerOf?: (modId: string) => string | null
}

export interface CatalogData {
  /** Null for a project the catalog doesn't show. */
  projects: ReadonlyMap<string, CatalogProject | null>
  /** Each project's versions that fit the target, newest first. */
  fitting: ReadonlyMap<string, readonly CatalogVersion[]>
  /** Versions by id: chosen ones, pinned ones, dependencies named by version. Null when not shown. */
  versions: ReadonlyMap<string, CatalogVersion | null>
  /** What each weighed version's jar asks for, by version id; null where it couldn't be read. */
  needs?: ReadonlyMap<string, JarNeeds | null>
}

/** Why a set of mods can't run together, worded by the web app. Names are project names. */
export type ModConflict =
  | { kind: 'unavailable'; mod: string; projectId: string }
  | { kind: 'no_fitting_version'; mod: string; projectId: string }
  /** Its versions for the release ask for a newer Java than the release runs on: `java` at least. */
  | { kind: 'needs_newer_java'; mod: string; projectId: string; java: number }
  /** Its versions for the release are add-ons of a newer `with` than runs there: `atLeast`. */
  | { kind: 'needs_newer'; mod: string; projectId: string; with: string; atLeast: string }
  | { kind: 'client_only'; mod: string; projectId: string }
  | { kind: 'missing_dependency'; mod: string; projectId: string; dependency: string }
  | { kind: 'incompatible'; mod: string; projectId: string; with: string }
  /** `madeFor`, for an uploaded datapack: the releases its formats cover, newest first. */
  | { kind: 'upload_does_not_fit'; mod: string; madeFor?: string[] }

export type Resolution =
  /** `jars`: versions whose jars must be read for what they ask of the server. */
  | { kind: 'need'; projects: string[]; versions: string[]; jars: string[] }
  | { kind: 'conflicts'; conflicts: ModConflict[] }
  | { kind: 'resolved'; mods: PinnedMod[] }

/** Only these project states may be picked: the rest are taken down or never shown. */
const PICKABLE = new Set(['approved', 'archived', 'unlisted'])
const CHANNELS = ['release', 'beta', 'alpha'] as const

interface Want {
  projectId: string
  versionId?: string | undefined
  origin: 'user' | 'dependency'
  /** The project that requires it. */
  by?: string
}

type Pick =
  | {
      kind: 'catalog'
      project: CatalogProject
      version: CatalogVersion
      environment: 'server' | 'optional' | 'both'
      origin: 'user' | 'dependency'
      requiredBy: Set<string>
    }
  /** Pinned before its project was taken down: kept as it is, for the owner to decide about. */
  | { kind: 'kept'; pin: PinnedMod; origin: 'user' | 'dependency'; requiredBy: Set<string> }

export function resolve(request: ResolveRequest, data: CatalogData): Resolution {
  const need = { projects: new Set<string>(), versions: new Set<string>(), jars: new Set<string>() }
  const conflicts: ModConflict[] = []
  const picked = new Map<string, Pick>()
  const excluded: Array<{ from: string; projectId: string | null; versionId: string | null }> = []
  const queue: Want[] = request.wanted.map((want) => ({ ...want, origin: 'user' }))

  const { target } = request
  const tested = testedIds(request)
  const fits = (version: CatalogVersion) => fitsTarget(version, target, tested)
  const nameOf = (projectId: string) =>
    data.projects.get(projectId)?.name ??
    request.current.find((m) => projectOf(m) === projectId)?.name ??
    projectId
  const upgrading = (projectId: string) => request.upgrade === 'all' || request.upgrade.has(projectId)
  // A mod that can't be picked: the owner's own choice, or what another of theirs requires.
  const refuse = (want: Want, conflict: ModConflict) =>
    conflicts.push(
      want.by === undefined
        ? conflict
        : {
            kind: 'missing_dependency',
            mod: nameOf(want.by),
            projectId: want.by,
            dependency: nameOf(want.projectId),
          },
    )

  while (queue.length > 0) {
    const want = queue.shift() as Want
    const already = picked.get(want.projectId)
    if (already !== undefined) {
      if (want.by !== undefined) already.requiredBy.add(want.by)
      if (want.origin === 'user') already.origin = 'user'
      continue
    }
    const project = data.projects.get(want.projectId)
    if (project === undefined) {
      need.projects.add(want.projectId)
      continue
    }
    if (project === null || !PICKABLE.has(project.state)) {
      if (!keepTakenDown(want))
        refuse(want, { kind: 'unavailable', mod: nameOf(want.projectId), projectId: want.projectId })
      continue
    }

    const version = choose(want)
    if (version === 'later') continue
    if ('held' in version) {
      refuse(want, refusal(version.held, { mod: project.name, projectId: want.projectId }))
      continue
    }
    const environment = request.environment(version.environment, version.loaders)
    if (environment === null) {
      refuse(want, { kind: 'client_only', mod: project.name, projectId: want.projectId })
      continue
    }
    picked.set(want.projectId, {
      kind: 'catalog',
      project,
      version,
      environment,
      origin: want.origin,
      requiredBy: new Set(want.by === undefined ? [] : [want.by]),
    })

    for (const dependency of [...version.dependencies, ...providedFor(request, data, version)]) {
      if (dependency.kind === 'incompatible') excluded.push({ from: want.projectId, ...dependency })
      if (dependency.kind !== 'required') continue
      let projectId = dependency.projectId
      if (projectId === null && dependency.versionId !== null) {
        const named = data.versions.get(dependency.versionId)
        if (named === undefined) {
          need.versions.add(dependency.versionId)
          continue
        }
        projectId = named?.projectId ?? null
      }
      if (projectId === null) {
        conflicts.push({
          kind: 'missing_dependency',
          mod: project.name,
          projectId: want.projectId,
          dependency: dependency.versionId ?? 'an unnamed project',
        })
        continue
      }
      queue.push({
        projectId,
        versionId: dependency.versionId ?? undefined,
        origin: 'dependency',
        by: want.projectId,
      })
    }
  }

  /**
   * An owner's exact choice must fit. Otherwise the pinned version stays while it fits, then
   * a version a dependency names if it fits, then the newest fitting release, beta or alpha, then
   * the newest version Cubepals ran on the target, each held to what its jar asks (`JarHold`).
   */
  function choose(want: Want): CatalogVersion | 'later' | { held: Held | null } {
    const jar = new JarHold(jarTarget(target, data, need, picked), fits)
    if (want.origin === 'user' && want.versionId !== undefined)
      return jar.byId(want.versionId, want.projectId) ?? jar.refused()
    const pinned = request.current.find((m) => projectOf(m) === want.projectId)
    const pinnedVersion = pinned && 'versionId' in pinned.source ? pinned.source.versionId : undefined
    const kept =
      pinnedVersion === undefined || upgrading(want.projectId) ? undefined : jar.byId(pinnedVersion)
    if (kept !== undefined) return kept
    const named = want.versionId === undefined ? undefined : jar.byId(want.versionId, want.projectId)
    if (named !== undefined) return named
    const fitting = data.fitting.get(want.projectId)
    if (fitting === undefined) return later({ project: want.projectId })
    return (
      jar.first(CHANNELS.flatMap((channel) => fitting.filter((v) => v.channel === channel))) ??
      newestTested(request, data, want.projectId, fits, later, (v) => jar.holds(v)) ??
      jar.refused()
    )
  }

  /**
   * A mod the server already pins stays while its project is taken down, unless it is being
   * upgraded or no longer fits: the owner decides whether to keep running it (§15.3), and the
   * catalog can't be asked what it requires, so what it required before comes along.
   */
  function keepTakenDown(want: Want): boolean {
    const pin = request.current.find((m) => projectOf(m) === want.projectId)
    if (pin === undefined || upgrading(want.projectId)) return false
    const pinFits =
      pin.gameVersions.includes(target.gameVersion) &&
      pin.loaders.some((loader) => target.loaders.includes(loader))
    if (!pinFits) return false
    picked.set(want.projectId, {
      kind: 'kept',
      pin,
      origin: want.origin,
      requiredBy: new Set(want.by === undefined ? [] : [want.by]),
    })
    for (const dependency of request.current) {
      const projectId = projectOf(dependency)
      if (projectId !== null && dependency.requiredBy.includes(pin.name))
        queue.push({ projectId, origin: 'dependency', by: want.projectId })
    }
    return true
  }

  function later(what: { project?: string; version?: string }): 'later' {
    if (what.project !== undefined) need.projects.add(what.project)
    if (what.version !== undefined) need.versions.add(what.version)
    return 'later'
  }

  // What a picked mod says it can't run with.
  for (const exclusion of excluded) {
    let projectId = exclusion.projectId
    if (projectId === null && exclusion.versionId !== null) {
      const named = data.versions.get(exclusion.versionId)
      if (named === undefined) {
        need.versions.add(exclusion.versionId)
        continue
      }
      projectId = named?.projectId ?? null
    }
    const other = projectId === null ? undefined : picked.get(projectId)
    if (other === undefined || projectId === null) continue
    const otherVersion = other.kind === 'catalog' ? other.version.versionId : versionOf(other.pin)
    if (exclusion.versionId !== null && otherVersion !== exclusion.versionId) continue
    const otherName = other.kind === 'catalog' ? other.project.name : other.pin.name
    conflicts.push({
      kind: 'incompatible',
      mod: nameOf(exclusion.from),
      projectId: exclusion.from,
      with: otherName,
    })
  }

  const uploads = request.current.filter((m) => !('versionId' in m.source))
  conflicts.push(...uploads.flatMap((upload) => misfit(upload, target)))

  conflicts.push(...jarsHeld(picked, jarTarget(target, data, need, picked), request, data))
  if (need.projects.size > 0 || need.versions.size > 0 || need.jars.size > 0)
    return { kind: 'need', projects: [...need.projects], versions: [...need.versions], jars: [...need.jars] }
  if (conflicts.length > 0) return { kind: 'conflicts', conflicts }

  const mods = [...picked.values()].map((pick) => pinOf(request, pick, nameOf))
  return { kind: 'resolved', mods: [...mods, ...uploads].sort(byName) }
}

/** A version that couldn't be picked, as the conflict it is: none fitting, or what its jar asks. */
function refusal(held: Held | null, mod: { mod: string; projectId: string }): ModConflict {
  if (held === null) return { kind: 'no_fitting_version', ...mod }
  return 'java' in held
    ? { kind: 'needs_newer_java', ...mod, java: held.java }
    : { kind: 'needs_newer', ...mod, ...held }
}

/** What this resolution holds jars to: the target's Java, and the versions picked so far. */
/** An upload pinned as it is, held to what it declares; a datapack says which releases it was made for. */
function misfit(upload: PinnedMod, target: ResolveRequest['target']): ModConflict[] {
  const gameVersionFits = upload.gameVersions.length === 0 || upload.gameVersions.includes(target.gameVersion)
  const loaderFits = upload.loaders.length === 0 || upload.loaders.some((l) => target.loaders.includes(l))
  if (gameVersionFits && loaderFits) return []
  const madeFor = isDatapack(upload) ? { madeFor: upload.gameVersions } : {}
  return [{ kind: 'upload_does_not_fit', mod: upload.name, ...madeFor }]
}

function jarTarget(
  target: ResolveRequest['target'],
  data: CatalogData,
  need: { versions: Set<string>; jars: Set<string> },
  picked: ReadonlyMap<string, Pick>,
): JarTarget {
  return {
    java: target.java,
    needs: data.needs,
    ask: need.jars,
    versions: data.versions,
    askVersions: need.versions,
    picked: (projectId) => {
      const pick = picked.get(projectId)
      return pick?.kind === 'catalog'
        ? { name: pick.project.name, versionLabel: pick.version.versionLabel }
        : undefined
    },
  }
}

/** What picked jars ask of the others picked that they don't give: a host's release, a mod. */
function jarsHeld(
  picked: ReadonlyMap<string, Pick>,
  jars: JarTarget,
  request: ResolveRequest,
  data: CatalogData,
): ModConflict[] {
  return [...addonsHeld(picked, jars), ...modsMissing(picked, request, data)]
}

/** Add-ons picked before the project they load on, held to the version of it picked after. */
function addonsHeld(picked: ReadonlyMap<string, Pick>, jars: JarTarget): ModConflict[] {
  return [...picked.values()].flatMap((pick) => {
    if (pick.kind !== 'catalog') return []
    const why = heldBack(jars, pick.version)
    if (why === null || why === 'later' || !('with' in why)) return []
    return [
      { kind: 'needs_newer' as const, mod: pick.project.name, projectId: pick.project.projectId, ...why },
    ]
  })
}

/**
 * What a version's jar says it requires and the catalog may not list, as the projects that provide
 * it, each once: required like any dependency the catalog lists.
 */
function providedFor(
  request: ResolveRequest,
  data: CatalogData,
  version: CatalogVersion,
): CatalogDependency[] {
  const declared = data.needs?.get(version.versionId)?.mod?.depends ?? []
  const providers = new Set(declared.map((modId) => request.providerOf?.(modId) ?? null))
  return [...providers].flatMap((projectId) =>
    projectId === null || projectId === version.projectId
      ? []
      : [{ projectId, versionId: null, kind: 'required' as const }],
  )
}

/**
 * The mods a picked jar's metadata requires that nothing picked answers to. Said only where every
 * jar picked was read, so none of them can be the one, and not for a jar that carries jars of its
 * own, which may hold it under another name: either way its first start tells.
 */
function modsMissing(
  picked: ReadonlyMap<string, Pick>,
  request: ResolveRequest,
  data: CatalogData,
): ModConflict[] {
  const { providerOf } = request
  // An upload may be the one, and nobody reads what it answers to.
  if (providerOf === undefined || request.current.some((m) => !('versionId' in m.source))) return []
  const jars = [...picked.values()].filter((pick) => pick.kind === 'kept' || !isDatapack(pick.version))
  const read = jars.flatMap((pick) => {
    const needs = pick.kind === 'catalog' ? data.needs?.get(pick.version.versionId) : undefined
    return needs === undefined || needs === null ? [] : [{ pick, mod: needs.mod ?? null }]
  })
  if (read.length < jars.length) return []
  const answered = new Set(read.flatMap(({ mod }) => mod?.ids ?? []))
  return read.flatMap(({ pick, mod }) => {
    if (pick.kind !== 'catalog' || mod === null || mod.carriesJars) return []
    return mod.depends
      .filter((modId) => !answered.has(modId) && !picked.has(providerOf(modId) ?? ''))
      .map((dependency) => ({
        kind: 'missing_dependency' as const,
        mod: pick.project.name,
        projectId: pick.project.projectId,
        dependency,
      }))
  })
}

const isDatapack = (version: { loaders: readonly string[] }) =>
  version.loaders.every((loader) => loader === DATAPACK)

const testedIds = (request: ResolveRequest): ReadonlySet<string> =>
  new Set((request.tested ?? []).map((entry) => entry.versionId))

/** Listed by the catalog for the target, or tested on it by Cubepals. */
function fitsTarget(
  version: CatalogVersion,
  target: ResolveRequest['target'],
  tested: ReadonlySet<string>,
): boolean {
  if (version.state === 'absent') return false
  if (tested.has(version.versionId)) return true
  return (
    version.gameVersions.includes(target.gameVersion) &&
    version.loaders.some((loader) => target.loaders.includes(loader))
  )
}

/**
 * The newest of a project's tested versions that fits, once the catalog has shown them all; null
 * where none was tested on the target.
 */
function newestTested(
  request: ResolveRequest,
  data: CatalogData,
  projectId: string,
  fits: (version: CatalogVersion) => boolean,
  later: (what: { version: string }) => 'later',
  holds: (version: CatalogVersion) => CatalogVersion | 'later' | undefined,
): CatalogVersion | null | 'later' {
  const ids = (request.tested ?? []).filter((entry) => entry.projectId === projectId).map((e) => e.versionId)
  const unseen = ids.filter((id) => !data.versions.has(id))
  if (unseen.length > 0) {
    for (const version of unseen) later({ version })
    return 'later'
  }
  const found = ids.flatMap((id) => {
    const version = data.versions.get(id)
    return version != null && version.projectId === projectId && fits(version) ? [version] : []
  })
  for (const version of found.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())) {
    const takes = holds(version)
    if (takes !== undefined) return takes
  }
  return null
}

const projectOf = (mod: PinnedMod): string | null => ('projectId' in mod.source ? mod.source.projectId : null)
const versionOf = (mod: PinnedMod): string | null => ('versionId' in mod.source ? mod.source.versionId : null)

/** A pinned version keeps the facts it was pinned with; a new one takes the catalog's. */
function pinOf(request: ResolveRequest, pick: Pick, nameOf: (projectId: string) => string): PinnedMod {
  const requiredBy = [...pick.requiredBy].map(nameOf).sort()
  if (pick.kind === 'kept') return { ...pick.pin, origin: pick.origin, requiredBy }
  const pinned = request.current.find(
    (m) => 'versionId' in m.source && m.source.versionId === pick.version.versionId,
  )
  if (pinned !== undefined) return { ...pinned, origin: pick.origin, requiredBy }
  const { version, project } = pick
  return {
    source: {
      catalog: catalogOfId(version.projectId, request.catalog),
      projectId: version.projectId,
      versionId: version.versionId,
    },
    name: project.name,
    versionLabel: version.versionLabel,
    artifact: {
      ref: { kind: 'remote', url: version.file.url },
      sha512: version.file.sha512,
      sizeBytes: version.file.sizeBytes,
      fileName: version.file.fileName,
    },
    environment: pick.environment,
    loaders: version.loaders,
    gameVersions: version.gameVersions,
    origin: pick.origin,
    requiredBy,
  }
}

/** The spec lists mods in this order, so the same set always makes the same spec. */
function byName(a: PinnedMod, b: PinnedMod): number {
  return a.name.localeCompare(b.name, 'en') || a.artifact.sha512.localeCompare(b.artifact.sha512)
}
