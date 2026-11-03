// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Curation fixture choices are explicit; production defaults are enabled only when requested. */
import { describe, expect, test } from 'bun:test'
import { OWN_PACKS } from '../app/curation/own.ts'
import { CURATED_PACKS } from '../app/curation/packs.ts'
import { hasDatabase, startHarness } from './harness.ts'

const admin = { kind: 'admin' as const, userId: 'fixture-reviewer' }

describe.skipIf(!hasDatabase)('harness curation choices', () => {
  test('ordinary fixtures keep review queues empty', async () => {
    const h = await startHarness()
    try {
      expect(await h.app.curation.review(admin)).toEqual([])
    } finally {
      await h.close()
    }
  }, 30_000)
  test('production fixtures use the actual offered pack defaults', async () => {
    const h = await startHarness({ productionCuration: true })
    try {
      expect((await h.app.curation.review(admin)).map((pack) => pack.key).sort()).toEqual(
        [...CURATED_PACKS, ...OWN_PACKS].map((pack) => pack.key).sort(),
      )
    } finally {
      await h.close()
    }
  }, 30_000)
  test('explicit review lists are preserved with either default mode', async () => {
    const curatedPacks = CURATED_PACKS.slice(0, 1),
      ownPacks = OWN_PACKS.slice(0, 1)
    for (const productionCuration of [false, true]) {
      const h = await startHarness({ productionCuration, curatedPacks, ownPacks })
      try {
        expect((await h.app.curation.review(admin)).map((pack) => pack.key).sort()).toEqual(
          [...curatedPacks, ...ownPacks].map((pack) => pack.key).sort(),
        )
      } finally {
        await h.close()
      }
    }
  }, 30_000)
})
