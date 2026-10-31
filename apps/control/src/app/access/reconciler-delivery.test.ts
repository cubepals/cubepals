// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Access delivery still completes when the independent moderation delivery fails. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { type Harness, startHarness } from '../../testing/harness.ts'
import { ModerationDelivery } from '../moderation/delivery.ts'
import { loadRuntime, lockServer } from '../servers/persistence.ts'
import { lockAccess, readAccess, setWhitelistPending } from './persistence.ts'

describe('access delivery when moderation fails', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  test('a moderation failure does not discard a successful whitelist switch', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const server = await h.server(id)
    const { handle } = await loadRuntime(h.db, id, [h.runtime.provider])
    if (handle === null) throw new Error('A running server must have a runtime handle')
    await h.db.transaction(async (tx) => {
      await lockServer(tx, id)
      await lockAccess(tx, id)
      await setWhitelistPending(tx, id, true)
    })

    const refused = spyOn(ModerationDelivery.prototype, 'deliver').mockRejectedValue(
      new Error('The moderation connection was interrupted'),
    )
    try {
      expect(await h.app.reconciler.reconcile(server, handle, 'full')).toEqual({ restart: false })
      expect(refused).toHaveBeenCalled()
      expect((await readAccess(h.db, id)).record).toMatchObject({
        whitelistEnabled: true,
        whitelistEnabledPending: null,
      })
      expect(await h.minecraft.file(id, 'server.properties')).toContain('white-list=true')
      expect(await h.minecraft.login(id, 'Stranger')).toBe('not whitelisted')
    } finally {
      refused.mockRestore()
    }
  }, 60_000)
})
