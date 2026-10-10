// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { AccessEntry } from '../../domain/access/access.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { lockServer } from '../servers/persistence.ts'
import { lockAccess, readAccess, saveReconciled } from './persistence.ts'

// An owner's access change and the sync that writes back what the server reported can land at
// the same moment. Both take the server's row and its access row; taken in opposite orders they
// deadlock: the change held the server row and waited for the access row, while the sync held
// the access row and waited on the server row for the foreign key of the entry it was saving.
describe.skipIf(!hasDatabase)('access locks', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a change and a sync that meet take the server first, and both finish', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)

    const before = await readAccess(h.db, id)
    const joined: AccessEntry = {
      list: 'whitelist',
      player: { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' },
      state: 'active',
      origin: 'game',
      details: {},
      error: null,
    }
    const after = { ...before.record, entries: [...before.record.entries, joined] }

    let serverHeld: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      serverHeld = resolve
    })
    let letGo: () => void = () => undefined
    const release = new Promise<void>((resolve) => {
      letGo = resolve
    })

    // The owner's change: the server row first, as every request takes it.
    const change = h.db.transaction(async (tx) => {
      await lockServer(tx, id)
      serverHeld()
      await release
      await lockAccess(tx, id)
    })

    // The sync starts while the change holds the server row.
    await held
    const sync = h.db.transaction((tx) => saveReconciled(tx, id, before, after))

    // Only once the sync is waiting on something does the change reach for the access row.
    for (let i = 0; i < 100; i++) {
      const waiting = await h.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
      )
      if ((waiting.rows[0]?.n ?? 0) > 0) break
      await Bun.sleep(20)
    }
    letGo()

    // A deadlock fails one of them; in the right order, both finish.
    await Promise.all([change, sync])
    const saved = await readAccess(h.db, id)
    expect(saved.record.entries.some((e) => e.player.name === 'Notch')).toBe(true)
  }, 60_000)
})
