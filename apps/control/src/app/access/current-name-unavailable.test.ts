// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A profile cache miss retains the recorded name while delivering a real access change. */
import { describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { FakeProfiles } from '../../infra/fake/fake-profiles.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { RuntimeRouter } from '../runtimes/router.ts'
import { loadRuntime, lockServer } from '../servers/persistence.ts'
import { lockAccess, readAccess, upsertEntry } from './persistence.ts'
import { AccessReconciler } from './reconciler.ts'

describe.skipIf(!hasDatabase)('access when a current profile name is unavailable', () => {
  test(
    'delivers the recorded player without requiring a cached current name',
    async () => {
      const h = await startHarness()
      try {
        const owner = await h.user()
        const created = await h.create(owner)
        const server = await h.until(created.id, 'running')
        await h.settled(server.id)
        const profile = await h.profiles.byName('Alex')
        if (!profile) throw new Error('The fixture player must have an account')
        const player = { ...profile, uuid: normalizeUuid(profile.uuid) }
        await h.db.transaction(async (tx) => {
          await lockServer(tx, server.id)
          await lockAccess(tx, server.id)
          await upsertEntry(
            tx,
            server.id,
            { list: 'operator', player, state: 'pending_add', origin: 'blockly', details: {}, error: null },
            owner.userId,
          )
        })
        const profiles = new FakeProfiles()
        expect(await profiles.byUuid(player.uuid)).toBeNull()
        const runtime = new RuntimeRouter([...h.runtimes.values()])
        const { handle } = await loadRuntime(h.db, server.id, runtime.providers)
        if (!handle) throw new Error('The server needs its running handle')
        const reconciler = new AccessReconciler({
          db: h.db,
          runtime,
          console: h.minecraft,
          profiles,
          specs: h.app.specs,
          events: h.events,
        })
        expect(await reconciler.reconcile(server, handle, 'full')).toEqual({ restart: false })
        expect((await readAccess(h.db, server.id)).record.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ list: 'operator', player, state: 'active', error: null }),
          ]),
        )
        expect(await h.minecraft.file(server.id, 'ops.json')).toContain('Alex')
      } finally {
        await h.close()
      }
    },
    30 * SECOND_MS,
  )
})
