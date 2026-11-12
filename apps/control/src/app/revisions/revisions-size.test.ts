// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A settings change that moves the server to another size with it, as the settings page saves
 * players, distance and size together: one revision and one restart, max players checked against
 * the size it moves to, and the size against the plan.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'

describe.skipIf(!hasDatabase)('settings with a size', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const settingsOf = async (id: string) =>
    (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
  const applies = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply').length

  test('settings and the size they need move in one change, checked against that size', async () => {
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { name: 'Moved up' })
    await h.until(id, 'running')
    await h.settled(id)
    const current = await settingsOf(id)
    // Ten players don't fit the size for five, unless the same change moves it up.
    await expect(
      h.app.revisions.changeSettings(owner, id, { ...current, maxPlayers: 10 }, randomUUID()),
    ).rejects.toThrow(/players/i)
    const before = await applies(id)
    await h.app.revisions.changeSettings(
      owner,
      id,
      { ...current, maxPlayers: 10, viewDistance: 12 },
      randomUUID(),
      {
        partySize: '10',
      },
    )
    await h.until(id, (s) => s.memoryTier === '4g' && s.lifecycle.status === 'running')
    await h.settled(id)
    expect(await settingsOf(id)).toMatchObject({ maxPlayers: 10, viewDistance: 12 })
    expect(await h.minecraft.file(id, 'server.properties')).toMatch(/^max-players=10$/m)
    // One change: one apply, one restart.
    expect(await applies(id)).toBe(before + 1)
    // The size alone, with nothing else changed, is a resize.
    await h.app.revisions.changeSettings(
      owner,
      id,
      { ...(await settingsOf(id)), maxPlayers: 5 },
      randomUUID(),
      {
        partySize: '5',
      },
    )
    await h.until(id, (s) => s.memoryTier === '3g' && s.lifecycle.status === 'running')
  })

  test('a size the plan doesn’t have is refused, as a resize would be', async () => {
    // The free plan has one size.
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Free' })
    await h.until(id, 'running')
    await h.settled(id)
    await expect(
      h.app.revisions.changeSettings(owner, id, await settingsOf(id), randomUUID(), { partySize: '10' }),
    ).rejects.toThrow(/plan does not include/)
  })
})
