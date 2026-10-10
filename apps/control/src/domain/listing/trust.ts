// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Entitlements } from '../account/entitlements.ts'
import type { AccountStanding } from '../account/standing.ts'
import type { PinnedMod } from '../mods/artifact.ts'
import type { ProjectState, VersionState } from '../mods/catalog.ts'
import type { PinnedModpack } from '../mods/modpack.ts'

/**
 * Whether a server's mods may be shown to strangers (§15.3). A pure function of local state: our
 * allowlist says yes, the catalog cache can take it back. Uploads are never trusted, and a jar
 * still being served by a CDN proves nothing.
 */

type UntrustedReason =
  | 'upload'
  /** Not a project Blockly has vouched for. */
  | 'not_allowlisted'
  /** Its project was taken down, hidden or withheld where it was published. */
  | 'project_revoked'
  /** Its version was taken down where it was published. */
  | 'version_revoked'
  /** The catalog cache has never seen it, so nothing says it is still published. */
  | 'unknown'
  /** A modpack, whose mods are the pack author's choice rather than anything Blockly vouches for. */
  | 'modpack'

export type Trust =
  | { kind: 'vanilla' }
  | { kind: 'catalog_trusted' }
  | { kind: 'untrusted'; mods: Array<{ name: string; reason: UntrustedReason }> }

export interface CatalogView {
  /** Projects vouched for, as `catalog:projectId`. */
  allowlisted: ReadonlySet<string>
  project(catalog: string, projectId: string): ProjectState | null
  version(catalog: string, versionId: string): VersionState | null
}

const TRUSTED_PROJECT: ReadonlySet<ProjectState> = new Set(['approved', 'archived'])
const TRUSTED_VERSION: ReadonlySet<VersionState> = new Set(['listed', 'archived', 'unlisted'])

export function trust(
  mods: readonly PinnedMod[],
  catalog: CatalogView,
  /** The pack the server plays, where it plays one: a whole experience Blockly didn't assemble. */
  modpack: PinnedModpack | null = null,
): Trust {
  // Blockly vouches for mods one at a time, and a pack is hundreds it never looked at. The
  // server runs perfectly well; it just isn't something to put in front of strangers.
  if (modpack !== null) return { kind: 'untrusted', mods: [{ name: modpack.name, reason: 'modpack' }] }
  if (mods.length === 0) return { kind: 'vanilla' }
  const untrusted: Array<{ name: string; reason: UntrustedReason }> = []
  for (const mod of mods) {
    const reason = untrustedBecause(mod, catalog)
    if (reason !== null) untrusted.push({ name: mod.name, reason })
  }
  return untrusted.length === 0 ? { kind: 'catalog_trusted' } : { kind: 'untrusted', mods: untrusted }
}

function untrustedBecause(mod: PinnedMod, catalog: CatalogView): UntrustedReason | null {
  if (!('versionId' in mod.source)) return 'upload'
  const { catalog: name, projectId, versionId } = mod.source
  if (!catalog.allowlisted.has(`${name}:${projectId}`)) return 'not_allowlisted'
  const project = catalog.project(name, projectId)
  const version = catalog.version(name, versionId)
  if (project === null || version === null) return 'unknown'
  if (!TRUSTED_PROJECT.has(project)) return 'project_revoked'
  if (!TRUSTED_VERSION.has(version)) return 'version_revoked'
  return null
}

// ─── Copying ────────────────────────────────────────────────────────────────────────────────

/**
 * Whether someone else may make a server like this one (§15.6). A copy hands a stranger the same
 * mods, so it is offered only for a setup Blockly vouches for, judged as the directory judges it:
 * an uploaded jar, a mod Blockly hasn't checked or a modpack keeps copying off, and the owner can't
 * turn it on (`locked`). A setup Blockly vouches for is its owner's to offer or keep.
 */
export function copying(verdict: Trust, ownerOffers: boolean): { allowed: boolean; locked: boolean } {
  if (verdict.kind === 'untrusted') return { allowed: false, locked: true }
  return { allowed: ownerOffers, locked: false }
}

// ─── Eligibility ────────────────────────────────────────────────────────────────────────────

type IneligibleCode =
  | 'not_running_yet'
  | 'untrusted_mods'
  | 'account_not_active'
  | 'restricted'
  | 'not_entitled'
  | 'server_deleted'

export interface IneligibleReason {
  code: IneligibleCode
  detail?: string
}

/**
 * Whether a listing may appear in the directory, apart from its owner's intent and moderation
 * (§15.3). The kill switch is applied when the directory is read, not here.
 */
export function eligibility(input: {
  /** Trust of the revision the server last booted; null when it never booted. */
  trust: Trust | null
  standing: Pick<AccountStanding, 'status' | 'restrictions'>
  entitlements: Pick<Entitlements, 'mayListPublicly'>
  deleted: boolean
}): { eligible: boolean; reasons: IneligibleReason[] } {
  const reasons: IneligibleReason[] = []
  if (input.deleted) reasons.push({ code: 'server_deleted' })
  if (input.trust === null) reasons.push({ code: 'not_running_yet' })
  else if (input.trust.kind === 'untrusted')
    for (const mod of input.trust.mods)
      reasons.push({ code: 'untrusted_mods', detail: `${mod.name}: ${mod.reason}` })
  if (input.standing.status !== 'active') reasons.push({ code: 'account_not_active' })
  if (input.standing.restrictions.publicListing) reasons.push({ code: 'restricted' })
  if (!input.entitlements.mayListPublicly) reasons.push({ code: 'not_entitled' })
  return { eligible: reasons.length === 0, reasons }
}
