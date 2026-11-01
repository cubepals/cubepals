// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A sync preserves an owner's newer whitelist request, then clears it after delivery. */
import { describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { readAccess, saveReconciled, setWhitelistPending } from './persistence.ts'

describe.skipIf(!hasDatabase)('whitelist changes during reconciliation', () => {
  test(
    'retains the newer request until a sync reads and delivers it',
    async () => {
      const h = await startHarness()
      try {
        const owner = await h.user()
        const created = await h.create(owner)
        await h.until(created.id, 'running')
        await h.settled(created.id)

        const before = await readAccess(h.db, created.id)
        expect(before.record.whitelistEnabledPending).toBeNull()
        await h.db.transaction(async (tx) => {
          // The owner's request arrives after this sync took its snapshot.
          await setWhitelistPending(tx, created.id, true)
          await saveReconciled(tx, created.id, before, before.record)
        })
        const waiting = await readAccess(h.db, created.id)
        expect(waiting.record.whitelistEnabledPending).toBe(true)
        expect(waiting.record.whitelistEnabled).toBe(false)

        // The next sync reads that request and acknowledges its actual delivery.
        await h.db.transaction((tx) =>
          saveReconciled(tx, created.id, waiting, {
            ...waiting.record,
            whitelistEnabled: true,
            whitelistEnabledPending: null,
          }),
        )
        const delivered = await readAccess(h.db, created.id)
        expect(delivered.record.whitelistEnabledPending).toBeNull()
        expect(delivered.record.whitelistEnabled).toBe(true)
        expect(delivered.version).toBeGreaterThan(waiting.version)
      } finally {
        await h.close()
      }
    },
    30 * SECOND_MS,
  )
})
