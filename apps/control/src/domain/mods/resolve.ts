import type { PinnedMod } from './artifact.ts'
import type { CatalogProject, CatalogVersion } from './catalog.ts'

/**
 * Which versions a server runs for the mods its owner wants, with everything they require
 * (docs/architecture.md §15.5). Pure: the catalog's answers come in as data. When they aren't
 * enough, the result says what else to fetch, and the caller asks again with more; each call
 * starts from scratch, so the answer depends only on the data.
 */

export interface ResolveRequest {
  /** The catalog every wanted mod comes from; pinned as each mod's source. */
  catalog: string
  target: { gameVersion: string; loaders: readonly string[] }
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
}

export interface CatalogData {
  /** Null for a project the catalog doesn't show. */
  projects: ReadonlyMap<string, CatalogProject | null>
  /** Each project's versions that fit the target, newest first. */
  fitting: ReadonlyMap<string, readonly CatalogVersion[]>
  /** Versions by id: chosen ones, pinned ones, dependencies named by version. Null when not shown. */
  versions: ReadonlyMap<string, CatalogVersion | null>
}

/** Why a set of mods can't run together, worded by the web app. Names are project names. */
export type ModConflict =
  | { kind: 'unavailable'; mod: string; projectId: string }
  | { kind: 'no_fitting_version'; mod: string; projectId: string }
  | { kind: 'client_only'; mod: string; projectId: string }
  | { kind: 'missing_dependency'; mod: string; projectId: string; dependency: string }
  | { kind: 'incompatible'; mod: string; projectId: string; with: string }
  | { kind: 'upload_does_not_fit'; mod: string }

export type Resolution =
  | { kind: 'need'; projects: string[]; versions: string[] }
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
  const need = { projects: new Set<string>(), versions: new Set<string>() }
  const conflicts: ModConflict[] = []
  const picked = new Map<string, Pick>()
  const excluded: Array<{ from: string; projectId: string | null; versionId: string | null }> = []
  const queue: Want[] = request.wanted.map((want) => ({ ...want, origin: 'user' }))

  const { target } = request
  const fits = (version: CatalogVersion) =>
    version.state !== 'absent' &&
    version.gameVersions.includes(target.gameVersion) &&
    version.loaders.some((loader) => target.loaders.includes(loader))
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
    if (version === null) {
      refuse(want, { kind: 'no_fitting_version', mod: project.name, projectId: want.projectId })
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

    for (const dependency of version.dependencies) {
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
   * a version a dependency names if it fits, then the newest fitting release, beta or alpha.
   */
  function choose(want: Want): CatalogVersion | null | 'later' {
    if (want.origin === 'user' && want.versionId !== undefined) {
      const exact = data.versions.get(want.versionId)
      if (exact === undefined) return later({ version: want.versionId })
      return exact !== null && exact.projectId === want.projectId && fits(exact) ? exact : null
    }
    const pinned = request.current.find((m) => projectOf(m) === want.projectId)
    const pinnedVersion = pinned && 'versionId' in pinned.source ? pinned.source.versionId : undefined
    if (pinnedVersion !== undefined && !upgrading(want.projectId)) {
      const kept = data.versions.get(pinnedVersion)
      if (kept === undefined) return later({ version: pinnedVersion })
      if (kept !== null && fits(kept)) return kept
    }
    if (want.versionId !== undefined) {
      const named = data.versions.get(want.versionId)
      if (named === undefined) return later({ version: want.versionId })
      if (named !== null && named.projectId === want.projectId && fits(named)) return named
    }
    const fitting = data.fitting.get(want.projectId)
    if (fitting === undefined) return later({ project: want.projectId })
    for (const channel of CHANNELS) {
      const newest = fitting.find((version) => version.channel === channel && fits(version))
      if (newest !== undefined) return newest
    }
    return null
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
  for (const upload of uploads) {
    const gameVersionFits =
      upload.gameVersions.length === 0 || upload.gameVersions.includes(target.gameVersion)
    const loaderFits = upload.loaders.length === 0 || upload.loaders.some((l) => target.loaders.includes(l))
    if (!gameVersionFits || !loaderFits) conflicts.push({ kind: 'upload_does_not_fit', mod: upload.name })
  }

  if (need.projects.size > 0 || need.versions.size > 0)
    return { kind: 'need', projects: [...need.projects], versions: [...need.versions] }
  if (conflicts.length > 0) return { kind: 'conflicts', conflicts }

  const mods = [...picked.values()].map((pick) => pinOf(request, pick, nameOf))
  return { kind: 'resolved', mods: [...mods, ...uploads].sort(byName) }
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
    source: { catalog: request.catalog, projectId: version.projectId, versionId: version.versionId },
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
