// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Restart decisions read real presence and the last applied configuration, including missing rows. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadApplied, waitsForPlayers } from './restart-wait.ts'

let h: Harness
beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30 * SECOND_MS)
afterAll(async () => {
  await h?.close()
})

test.skipIf(!hasDatabase)(
  'only real players on a running server hold a restart, and applied records round-trip',
  async () => {
    const owner = await h.user('Restart reader', 'plus')
    const created = await h.create(owner)
    await h.until(created.id, 'running', 3 * SECOND_MS)
    await h.settled(created.id, 3 * SECOND_MS)
    const server = await h.server(created.id)
    const [runtime] = await h.db
      .select()
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, server.id))
    if (!runtime?.applied) throw new Error('The running fixture must have an applied configuration')
    expect(await loadApplied(h.db, server.id)).toEqual(runtime.applied)
    expect(await loadApplied(h.db, crypto.randomUUID())).toBeNull()
    await h.db
      .update(schema.serverRuntimes)
      .set({ applied: null })
      .where(eq(schema.serverRuntimes.serverId, server.id))
    expect(await loadApplied(h.db, server.id)).toBeNull()
    await h.db
      .update(schema.serverRuntimes)
      .set({ applied: runtime.applied })
      .where(eq(schema.serverRuntimes.serverId, server.id))
    expect(await waitsForPlayers(h.db, server, 'empty')).toBe(false)
    h.minecraft.join(server.id, { uuid: crypto.randomUUID(), name: 'MossPlayer' })
    await h.app.schedules.presenceSync()
    expect(await waitsForPlayers(h.db, server, 'empty')).toBe(true)
    expect(await waitsForPlayers(h.db, server, 'now')).toBe(false)
    expect(
      await waitsForPlayers(
        h.db,
        { ...server, lifecycle: { ...server.lifecycle, status: 'stopped' } },
        'empty',
      ),
    ).toBe(false)
    expect(await waitsForPlayers(h.db, { ...server, id: crypto.randomUUID() }, 'empty')).toBe(false)
  },
  30 * SECOND_MS,
)
