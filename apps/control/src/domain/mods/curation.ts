/**
 * Packs Blockly offers by name (docs/modpack-templates.md): real packs their authors publish, each
 * reviewed for what its licences let Blockly do with it, and pinned release by release. A server
 * plays one exact release, written `key@version`, and never moves off it by itself.
 *
 * Everything here is a rule over facts someone gathered: which licence each file declares, what a
 * reviewer found a licence of its own to mean, which authors gave written permission. Gathering
 * the facts is ingestion's (app/curation); deciding what they allow is this module's.
 */

// ─── Releases, by name ──────────────────────────────────────────────────────────────────────

/** A pack's key: lower-case words joined by hyphens, as short as an address and never reused. */
const KEY = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
/** A release's version as its author numbers it, without anything that makes a reference ambiguous. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** One release of one curated pack. */
export interface ReleaseRef {
  key: string
  version: string
}

export const isPackKey = (key: string): boolean => KEY.test(key)
export const isReleaseVersion = (version: string): boolean => VERSION.test(version)

/** `adrenaserver@1.7.0+1.21.1.fabric`: how a release is named wherever a person or a log reads it. */
export const releaseRef = (release: ReleaseRef): string => `${release.key}@${release.version}`

export function parseReleaseRef(text: string): ReleaseRef | null {
  const at = text.indexOf('@')
  if (at < 0) return null
  const key = text.slice(0, at)
  const version = text.slice(at + 1)
  return isPackKey(key) && isReleaseVersion(version) ? { key, version } : null
}

// ─── Licences ───────────────────────────────────────────────────────────────────────────────

/**
 * What a licence lets a hosting company do with work it didn't write, read conservatively:
 * - `open`: copy it and pass it on, for money too, keeping its notices (MIT, BSD, Apache, CC-BY);
 * - `copyleft`: the same, and its source offered with every copy (GPL, LGPL, MPL, CC-BY-SA);
 * - `noncommercial`: nothing in a paid product (CC-BY-NC and its kind);
 * - `reserved`: nothing beyond using it, without the author's permission (all rights reserved);
 * - `custom`: terms of its own, which a person has to read before anything is done with it;
 * - `unknown`: no licence found at all.
 */
export type LicenceKind = 'open' | 'copyleft' | 'noncommercial' | 'reserved' | 'custom' | 'unknown'

/**
 * Licences that allow commercial copies with their notices kept. A copy Blockly keeps is never
 * changed, so a licence that forbids changes (CC-BY-ND) allows it too, as a verbatim copy.
 */
const OPEN: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-ND-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
  'WTFPL',
  'Zlib',
])

/** Licences that allow commercial copies when their source is offered with every one. */
const COPYLEFT: ReadonlySet<string> = new Set([
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
  'EPL-2.0',
  'EUPL-1.2',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MPL-2.0',
  'OSL-3.0',
])

/** From least to most restrictive: what `AND` takes the last of, and `OR` the first. */
const RESTRICTION: readonly LicenceKind[] = [
  'open',
  'copyleft',
  'custom',
  'noncommercial',
  'reserved',
  'unknown',
]
const stricter = (a: LicenceKind, b: LicenceKind) =>
  RESTRICTION.indexOf(a) >= RESTRICTION.indexOf(b) ? a : b
const looser = (a: LicenceKind, b: LicenceKind) => (RESTRICTION.indexOf(a) <= RESTRICTION.indexOf(b) ? a : b)

/**
 * The kind of licence an SPDX identifier names, as a catalog declares it. An expression joining
 * licences is read the way SPDX means it: `AND` binds every part, `OR` offers a choice, and `WITH`
 * only ever adds an exception to the licence it follows. Anything grouped in brackets is left to a
 * person to read (`custom`).
 */
export function licenceKind(licence: string | null): LicenceKind {
  const expression = licence?.trim() ?? ''
  if (expression === '') return 'unknown'
  if (/[()]/.test(expression)) return 'custom'
  const either = expression.split(/\s+OR\s+/)
  if (either.length > 1) return either.map(licenceKind).reduce(looser)
  const every = expression.split(/\s+AND\s+/)
  if (every.length > 1) return every.map(licenceKind).reduce(stricter)
  const id = expression.split(/\s+WITH\s+/)[0] ?? ''
  if (/^LicenseRef-(ARR|All-?Rights-?Reserved)$/i.test(id)) return 'reserved'
  if (/(^|-)NC(-|$)|noncommercial/i.test(id)) return 'noncommercial'
  if (OPEN.has(id)) return 'open'
  if (COPYLEFT.has(id)) return 'copyleft'
  return 'custom'
}

/**
 * What keeping a copy of work under this kind of licence obliges Blockly to do: keep its notices,
 * and for copyleft, offer the source that goes with the bytes.
 */
export function obligations(kind: LicenceKind): Array<'notices' | 'source'> {
  if (kind === 'open') return ['notices']
  if (kind === 'copyleft') return ['notices', 'source']
  return []
}

// ─── What a pack's licences allow ───────────────────────────────────────────────────────────

/**
 * How a server gets a release's files:
 * - `mirror`: from Blockly's own store, where it keeps one verified copy of every file a server
 *   installs, as a pack of its own that downloads nothing else;
 * - `upstream`: from where its authors published each file, at the exact bytes Blockly verified,
 *   so Blockly copies nothing and hands nothing on.
 */
export type Distribution = 'mirror' | 'upstream'

/**
 * Someone's work that a release puts on a server: the pack's own files, or one mod, library or
 * pack of assets inside it.
 */
export interface ReviewedWork {
  /** What a person reads it as: the mod's or the pack's name, or the file's path. */
  name: string
  /** Its project on the catalog that publishes it; null for a file only the pack carries. */
  project: { catalog: string; projectId: string } | null
  /** The licence its publisher declares, as an SPDX identifier or expression; null for none. */
  licence: string | null
}

export interface LicenceReview {
  /** The pack's own files: its index, its configuration and what else its author wrote into it. */
  pack: ReviewedWork
  /** Every file of someone else's that a server of it installs. */
  files: ReviewedWork[]
}

/** A reviewer's reading of a licence its identifier doesn't settle, and where the licence says so. */
export interface LicenceReading {
  licence: string
  reads: LicenceKind
  /** Where the words that decide it are quoted (a section of docs/modpack-templates.md). */
  evidence: string
}

/** An author's written permission for what their licence alone doesn't allow Blockly to do. */
export interface Permission {
  catalog: string
  projectId: string
  /** The most it allows; permission to keep a copy covers offering the pack from upstream too. */
  grants: Distribution
  /** Where the permission is kept (a section of docs/modpack-templates.md). */
  evidence: string
}

/** Why a work stands in the way. */
type BlockedBecause =
  /** All rights reserved: nothing but ordinary use without the author's permission. */
  | 'reserved'
  /** Its licence forbids commercial use, and Blockly is a paid product. */
  | 'noncommercial'
  /** A licence of its own that nobody at Blockly has read yet, or no licence found at all. */
  | 'unread'

export interface Blocker {
  name: string
  licence: string | null
  because: BlockedBecause
}

export interface CurationVerdict {
  /**
   * Whether Blockly may keep a copy of every file and hand it to its servers: only when every
   * work may be copied commercially, or its author gave permission. What the copy obliges comes
   * with it, work by work.
   */
  mirror: {
    allowed: boolean
    blockers: Blocker[]
    obligations: Array<{ name: string; licence: string | null; owes: Array<'notices' | 'source'> }>
  }
  /**
   * Whether Blockly may offer the pack by name for servers to fetch from its authors: the pack's
   * own licence must allow its use in a paid product (or its author said yes), nothing inside may
   * be for noncommercial use only, and every licence of its own has been read. All-rights-reserved
   * mods are fine here: nothing of theirs is copied, and a server fetches and runs them from where
   * their authors published them, as any player's launcher does. Some licences ask for exactly
   * that (Fzzy Config's TDL-M lets a pack include it only "via a manifest which would download this
   * software from its respective CurseForge or Modrinth page").
   */
  upstream: { allowed: boolean; blockers: Blocker[] }
}

/**
 * What a pack's licences let Blockly do, work by work (docs/modpack-templates.md § Licences).
 * A reading replaces the kind an identifier would be taken for; a permission lifts whatever the
 * licence withholds, as far as it grants.
 */
export function judgeLicences(
  review: LicenceReview,
  readings: readonly LicenceReading[] = [],
  permissions: readonly Permission[] = [],
): CurationVerdict {
  const kindOf = (work: ReviewedWork): LicenceKind =>
    readings.find((reading) => reading.licence === work.licence)?.reads ?? licenceKind(work.licence)
  const granted = (work: ReviewedWork, wanted: Distribution): boolean =>
    work.project !== null &&
    permissions.some(
      (permission) =>
        permission.catalog === work.project?.catalog &&
        permission.projectId === work.project.projectId &&
        (permission.grants === 'mirror' || permission.grants === wanted),
    )
  const blocker = (work: ReviewedWork, kind: LicenceKind): Blocker => ({
    name: work.name,
    licence: work.licence,
    because: kind === 'reserved' || kind === 'noncommercial' ? kind : 'unread',
  })

  const works = [review.pack, ...review.files]
  const mirrorBlockers: Blocker[] = []
  const owed: CurationVerdict['mirror']['obligations'] = []
  for (const work of works) {
    const kind = kindOf(work)
    if (kind === 'open' || kind === 'copyleft')
      owed.push({ name: work.name, licence: work.licence, owes: obligations(kind) })
    else if (granted(work, 'mirror')) owed.push({ name: work.name, licence: work.licence, owes: ['notices'] })
    else mirrorBlockers.push(blocker(work, kind))
  }

  const upstreamBlockers: Blocker[] = []
  const packKind = kindOf(review.pack)
  // The pack is what Blockly puts its name beside, so its own licence has to allow a paid product.
  if (!['open', 'copyleft'].includes(packKind) && !granted(review.pack, 'upstream'))
    upstreamBlockers.push(blocker(review.pack, packKind))
  // What runs on the server has to be usable in a paid product: never noncommercial, and never a
  // licence of its own nobody has read, which could say anything about hosting.
  for (const work of review.files) {
    const kind = kindOf(work)
    if (!['noncommercial', 'custom', 'unknown'].includes(kind) || granted(work, 'upstream')) continue
    upstreamBlockers.push(blocker(work, kind))
  }

  return {
    mirror: { allowed: mirrorBlockers.length === 0, blockers: mirrorBlockers, obligations: owed },
    upstream: { allowed: upstreamBlockers.length === 0, blockers: upstreamBlockers },
  }
}

/**
 * The distribution a release gets: the one its review asked for, when its licences allow it now.
 * A review that asked for a mirror the licences no longer allow is refused rather than quietly
 * offered another way: a licence that changed under a pack is for a person to look at. Without a
 * store to keep copies in, a pack that may be mirrored is offered from upstream instead.
 */
export function distributionFor(
  verdict: CurationVerdict,
  wanted: Distribution,
  canStore: boolean,
): { distribution: Distribution } | { refused: Blocker[] } {
  if (wanted === 'mirror') {
    if (!verdict.mirror.allowed) return { refused: verdict.mirror.blockers }
    if (canStore) return { distribution: 'mirror' }
  }
  return verdict.upstream.allowed ? { distribution: 'upstream' } : { refused: verdict.upstream.blockers }
}

// ─── A release's life ───────────────────────────────────────────────────────────────────────

/**
 * - `pending`: reviewed and waiting to be fetched and checked;
 * - `verified`: every byte checked, not yet offered;
 * - `published`: offered to anyone making a server;
 * - `withdrawn`: offered to nobody new, and still installed by every server that plays it;
 * - `refused`: checking it found something wrong, said in words for an admin.
 */
export type ReleaseState = 'pending' | 'verified' | 'published' | 'withdrawn' | 'refused'
export type ReleaseEvent = 'verified' | 'refused' | 'publish' | 'withdraw' | 'retry'

const MOVES: Record<ReleaseState, Partial<Record<ReleaseEvent, ReleaseState>>> = {
  pending: { verified: 'verified', refused: 'refused' },
  refused: { retry: 'pending' },
  // A release checked once stays checked: its bytes never change, so it never goes back to pending.
  verified: { publish: 'published', withdraw: 'withdrawn' },
  published: { withdraw: 'withdrawn' },
  withdrawn: { publish: 'published' },
}

/** Where an event takes a release, or null for one that doesn't apply to it. */
export const nextState = (state: ReleaseState, event: ReleaseEvent): ReleaseState | null =>
  MOVES[state][event] ?? null

/**
 * Whether servers may install it. Withdrawing a release takes it from the list new servers pick
 * from, never from a server that plays it: their files stay where they are, and a rollback to it
 * still works.
 */
export const installable = (state: ReleaseState): boolean =>
  state === 'verified' || state === 'published' || state === 'withdrawn'

/**
 * The release a new server gets: the first published one in the pack's own order, which the
 * review keeps newest first. Null when none is published.
 */
export function offeredRelease<T extends { version: string; state: ReleaseState }>(
  order: readonly string[],
  releases: readonly T[],
): T | null {
  for (const version of order) {
    const release = releases.find((candidate) => candidate.version === version)
    if (release?.state === 'published') return release
  }
  return null
}

/**
 * A published release newer than the one a server plays, in the pack's own order: what its owner
 * is offered, and never applied by itself. Null when it plays the newest, or one the order doesn't
 * know.
 */
export function newerRelease<T extends { version: string; state: ReleaseState }>(
  order: readonly string[],
  releases: readonly T[],
  playing: string,
): T | null {
  const at = order.indexOf(playing)
  if (at < 0) return null
  return offeredRelease(order.slice(0, at), releases)
}
