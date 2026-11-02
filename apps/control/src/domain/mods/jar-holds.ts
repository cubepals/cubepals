// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holding a version to what its own jar asks of the server, which no catalog says: the Java its
 * classes need, against the Java the server runs, and for an add-on, the release of what it loads
 * on, against the one picked. Resolution (`resolve.ts`) asks this of every version that fits the
 * listing; it is not where a listing is matched, nor where the jars are read (`app/mods/jar-needs.ts`).
 */
import { DATAPACK } from './artifact.ts'
import type { CatalogVersion } from './catalog.ts'

/** What a version's jar asks of the server, read from the jar itself. */
export interface JarNeeds {
  /** The Java its classes need; null where none could be read. */
  java: number | null
  /** For an add-on, the project it loads on and the oldest version of it that it loads on. */
  api: { projectId: string; atLeast: string } | null
  /** For a Fabric mod, what its fabric.mod.json says; null for any other jar. Absent: not read. */
  mod?: FabricMod | null
  /** Each loader's own declaration, kept separately for universal jars. */
  native?: Readonly<Record<string, LoaderMod>>
}

export interface LoaderMod extends FabricMod {
  version: string | null
  environment: 'client' | 'server' | 'both'
  /** Only complete declarations can disambiguate a catalog's cross-loader dependency union. */
  complete: boolean
  requirements: Array<{ id: string; versions: readonly string[] }>
}

/** A Fabric mod, as its jar's fabric.mod.json says. */
export interface FabricMod {
  /** The mod ids it answers to: its own and the ones it says it provides. */
  ids: string[]
  /** The mods it won't load without that neither Fabric Loader nor its own jar holds. */
  depends: string[]
  /** Whether it carries jars of its own, which may hold some of those under other names. */
  carriesJars: boolean
}

/** What keeps a version's jar off the server: the Java it needs, or the release of its host. */
export type Held = { java: number } | { with: string; atLeast: string }

/** What one resolution holds jars to, and where it asks for the jars it hasn't read. */
export interface JarTarget {
  /** The Java the server runs; nothing is held to anything without it. */
  java: number | undefined
  needs: ReadonlyMap<string, JarNeeds | null> | undefined
  /** Where the jars still to read are asked for. */
  ask: Set<string>
  /** The versions the catalog has shown by id, and where the ones it hasn't are asked for. */
  versions: ReadonlyMap<string, CatalogVersion | null>
  askVersions: Set<string>
  /** The version picked of a project so far, by its name and label. */
  picked: (projectId: string) => { name: string; versionLabel: string } | undefined
}

/** Jars asked to be read in one round, in the order they would be picked. */
const READS_PER_ROUND = 8

/**
 * What a version's jar asks for, where its jar is weighed at all: not without a Java to hold it
 * to, and never a datapack's, which has none. `later` until it has been read, which `ask` requests.
 */
function needsOf(target: JarTarget, version: CatalogVersion, ask = true): JarNeeds | null | 'later' {
  if (target.java === undefined || version.loaders.every((loader) => loader === DATAPACK)) return null
  const needs = target.needs?.get(version.versionId)
  if (needs !== undefined) return needs
  if (ask) target.ask.add(version.versionId)
  return 'later'
}

/**
 * Why the server can't give a version what its jar asks, or null when it can: a newer Java than
 * it runs, or a newer release of the project it is an add-on of than the one picked.
 */
export function heldBack(target: JarTarget, version: CatalogVersion): Held | null | 'later' {
  const needs = needsOf(target, version)
  if (needs === 'later' || needs === null) return needs
  if (needs.java !== null && target.java !== undefined && needs.java > target.java)
    return { java: needs.java }
  const host = needs.api === null ? undefined : target.picked(needs.api.projectId)
  if (needs.api !== null && host !== undefined && olderThan(host.versionLabel, needs.api.atLeast))
    return { with: host.name, atLeast: needs.api.atLeast }
  return null
}

/**
 * One choice's versions, each held to the listing (`fits`) and then to what its jar asks.
 * Remembers why the ones its jar kept off were, so a choice left with none says what they asked.
 */
export class JarHold {
  readonly #target: JarTarget
  readonly #fits: (version: CatalogVersion) => boolean
  #held: Held | null = null

  constructor(target: JarTarget, fits: (version: CatalogVersion) => boolean) {
    this.#target = target
    this.#fits = fits
  }

  /**
   * The version where it fits, `also` holds, and the server gives its jar what it asks; `later`
   * until its jar is read; otherwise undefined.
   */
  holds(version: CatalogVersion | null, also = true): CatalogVersion | 'later' | undefined {
    if (version === null || !also || !this.#fits(version)) return undefined
    const why = heldBack(this.#target, version)
    if (why === null) return version
    if (why === 'later') return 'later'
    const held = this.#held
    if (held === null || ('java' in why && 'java' in held && why.java < held.java)) this.#held = why
    return undefined
  }

  /**
   * A version by its id, held as `holds` holds it, and to `projectId` where one is given; `later`
   * until the catalog has shown it.
   */
  byId(versionId: string, projectId?: string): CatalogVersion | 'later' | undefined {
    const version = this.#target.versions.get(versionId)
    if (version !== undefined)
      return this.holds(version, projectId === undefined || version?.projectId === projectId)
    this.#target.askVersions.add(versionId)
    return 'later'
  }

  /**
   * The first of these that holds. Where one comes to a jar not yet read, the unread ones are asked
   * for together, in the order they would be picked, and the answer waits for them.
   */
  first(candidates: readonly CatalogVersion[]): CatalogVersion | 'later' | undefined {
    for (const version of candidates) {
      const takes = this.holds(version)
      if (takes !== 'later') {
        if (takes !== undefined) return takes
        continue
      }
      const unread = candidates.filter(
        (one) => this.#fits(one) && needsOf(this.#target, one, false) === 'later',
      )
      for (const next of unread.slice(0, READS_PER_ROUND)) this.#target.ask.add(next.versionId)
      return 'later'
    }
    return undefined
  }

  /** Why the versions passed over were: null where none was passed over for its jar. */
  refused(): { held: Held | null } {
    return { held: this.#held }
  }
}

/** Whether a version label is older than a dotted release: `3.16.2` is older than `3.22.0`. */
function olderThan(label: string, release: string): boolean {
  const parts = (v: string) => (/^\d+(\.\d+)*/.exec(v.trim())?.[0] ?? '').split('.').map(Number)
  const [a, b] = [parts(label), parts(release)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff < 0
  }
  return false
}
