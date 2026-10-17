// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A test account's play is never sent to be billed (`ExtraUsage.send`), so a test account never
 * plays extra hours: marked on an account Polar bills, extra play stops with the flag.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { hasDatabase } from '../../testing/harness.ts'
import { PolarWorld } from '../../testing/polar-world.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

test.skipIf(!hasDatabase)(
  'an account Polar bills is never left playing extra it is never billed for',
  async () => {
    const { owner } = await w.subscriber('Vic')
    await w.h.app.accounts.allowExtraPlay(owner, 20)
    const admin = { kind: 'admin', userId: 'admin' } as const
    const marked = await w.h.app.accounts.setTestAccount(admin, owner.userId, true).then(
      () => true,
      () => false,
    )
    const extra = (await w.h.app.accountQueries.overview(owner)).usage.extra
    // Either the flag is refused on a paying account, or extra play stops with it.
    expect(marked && extra.may).toBe(false)
  },
)
