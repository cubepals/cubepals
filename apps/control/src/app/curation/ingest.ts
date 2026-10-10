// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ingestion of one pending release (docs/modpack-templates.md § Ingestion): the check that applies
 * to it run in a work directory of its own, and what it found kept once, or its refusal recorded.
 *
 * It doesn't check anything itself: the checks (`catalog-check.ts`, `own-check.ts`) are handed in.
 * It doesn't decide which releases are pending either (`queue.ts`), or move a release any other
 * way (`moves.ts`).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from '@blockly/db'
import { type ReleaseRef, releaseRef } from '../../domain/mods/curation.ts'
import { recordStored } from '../artifacts/persistence.ts'
import { leavePackJarOut, savePackContents } from '../packs/persistence.ts'
import { audit } from './audit.ts'
import { type Checked, Refused } from './check-outcome.ts'
import { type OwnPack, ownGameVersion, ownPack } from './own.ts'
import { type CuratedPack, type CuratedReleaseSpec, curatedPack } from './packs.ts'
import { loadRelease, releaseRefused, releaseVerified } from './persistence.ts'

/**
 * `curation-ingest`: one reviewed release, fetched and checked (docs/modpack-templates.md
 * § Ingestion). What it finds is kept once; anything wrong refuses the release, in a sentence
 * for an admin, with the detail behind it. A catalog or a host that doesn't answer is tried again.
 */
export async function ingest(
  deps: {
    db: Db
    packs: readonly CuratedPack[]
    own: readonly OwnPack[]
    checkCatalog: (pack: CuratedPack, spec: CuratedReleaseSpec, work: string) => Promise<Checked>
    checkOwn: (pack: OwnPack, version: string, gameVersion: string, work: string) => Promise<Checked>
  },
  release: ReleaseRef,
): Promise<void> {
  const pack = curatedPack(release.key, deps.packs)
  const spec = pack?.releases.find((candidate) => candidate.version === release.version)
  const own = ownPack(release.key, deps.own)
  const gameVersion = ownGameVersion(release.version)
  const check =
    pack !== null && spec !== undefined
      ? (work: string) => deps.checkCatalog(pack, spec, work)
      : own !== null && gameVersion !== null
        ? (work: string) => deps.checkOwn(own, release.version, gameVersion, work)
        : null
  // Taken out of the review since it was queued: left as it was.
  if (check === null) return
  const record = await loadRelease(deps.db, release.key, release.version)
  if (record?.state !== 'pending') return
  const work = await mkdtemp(join(tmpdir(), 'blockly-curation-'))
  try {
    const checked = await check(work)
    await deps.db.transaction(async (tx) => {
      if (checked.stored !== null) await recordStored(tx, { ...checked.stored, source: 'curated' })
      if (checked.contents !== null) await savePackContents(tx, checked.contents)
      for (const path of checked.forPlayers)
        await leavePackJarOut(tx, spec?.sha512 ?? checked.pack.artifact.sha512, { path, why: 'players' })
      const verified = await releaseVerified(tx, release.key, release.version, {
        distribution: checked.distribution,
        pack: checked.pack,
        facts: checked.facts,
        at: new Date(),
      })
      if (!verified) return
      await audit(tx, 'system:curation', 'curation.verified', releaseRef(release), {
        distribution: checked.distribution,
        sha512: checked.pack.artifact.sha512,
      })
    })
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    await refuse(deps.db, release, error.message, error.detail)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** A check whose job gave up: refused with what went wrong, for an admin to try again. */
export async function ingestGaveUp(db: Db, release: ReleaseRef, error: string): Promise<void> {
  await refuse(db, release, 'Cubepals couldn’t finish checking this release. Try again.', error)
}

async function refuse(db: Db, release: ReleaseRef, refusal: string, detail: string): Promise<void> {
  await db.transaction(async (tx) => {
    const at = new Date()
    if (!(await releaseRefused(tx, release.key, release.version, { refusal, detail, at }))) return
    await audit(tx, 'system:curation', 'curation.refused', releaseRef(release), { refusal, detail })
  })
}
