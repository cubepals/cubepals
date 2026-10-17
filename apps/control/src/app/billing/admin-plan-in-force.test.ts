// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the admin pages say an account's plan is: the plan in force (`loadStanding`, which reads
 * Polar's word, years and gifts before the plan set on the account), so a Plus subscriber shows
 * as Plus there.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { hasDatabase } from '../../testing/harness.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { loadStanding } from '../accounts/persistence.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

test.skipIf(!hasDatabase)(
  'the admin pages show a paying subscriber’s plan as the plan in force',
  async () => {
    const { owner } = await w.subscriber('Abe')
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
    const admin = { kind: 'admin', userId: 'admin' } as const
    const detail = await w.h.app.accountQueries.get(admin, owner.userId)
    expect(detail.standing.plan).toBe('plus')
    // Where it comes from, and the plan set underneath it that applies once Polar's ends.
    expect(detail.planFrom).toBe('subscription')
    expect(detail.setPlan).toBe('free')
    expect(detail.planRenews).toBe(true)
  },
)
