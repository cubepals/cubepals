// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Access delivery against the real database and fake game, with one provider failure at a time.
 * Pending changes are written without enqueueing a sync, then reconciled directly: no background
 * retry can erase the failure before its saved state and the game's files have been checked.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { READ_ACCESS_FILES } from '../../minecraft/access.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { type Harness, startHarness } from '../../testing/harness.ts'
import { loadRuntime, lockServer } from '../servers/persistence.ts'
import { lockAccess, markReseed, readAccess, setWhitelistPending, upsertEntry } from './persistence.ts'
import { AccessReseedFailed } from './reconciler.ts'

describe('access delivery after a provider refusal', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  const running = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.access.add(owner, created.id, 'whitelist', 'Steve')
    await h.settled(created.id)
    const server = await h.server(created.id)
    const { handle } = await loadRuntime(h.db, server.id, [h.runtime.provider])
    if (handle === null) throw new Error('A running server must have its runtime handle')
    return { server, handle }
  }

  for (const failure of ['rejection', 'nonzero exit'] as const) {
    test(`a whitelist write ${failure} preserves both pending changes until a successful retry`, async () => {
      const { server, handle } = await running()
      const existing = (await readAccess(h.db, server.id)).record.entries.find(
        (entry) => entry.list === 'whitelist' && entry.player.name === 'Steve',
      )
      if (!existing) throw new Error('The initial whitelist entry must have been delivered')
      const profile = await h.profiles.byName('Alex')
      if (!profile) throw new Error('Alex must have a Minecraft account')
      const joining = { uuid: normalizeUuid(profile.uuid), name: profile.name }
      await h.db.transaction(async (tx) => {
        await lockServer(tx, server.id)
        await lockAccess(tx, server.id)
        await upsertEntry(tx, server.id, { ...existing, state: 'pending_remove', error: null }, null)
        await upsertEntry(
          tx,
          server.id,
          {
            list: 'whitelist',
            player: joining,
            state: 'pending_add',
            origin: 'blockly',
            details: {},
            error: null,
          },
          null,
        )
      })

      const original = h.runtime.exec.bind(h.runtime)
      const refused = spyOn(h.runtime, 'exec').mockImplementation(async (target, command, timeout) => {
        if (command === READ_ACCESS_FILES) return original(target, command, timeout)
        if (failure === 'rejection') throw new Error('The provider connection was interrupted')
        return { exitCode: 1, stdout: '', stderr: 'The volume refused the write' }
      })
      try {
        expect(await h.app.reconciler.reconcile(server, handle, 'full')).toEqual({ restart: false })
        const pending = (await readAccess(h.db, server.id)).record.entries
        expect(pending.map((entry) => [entry.player.name, entry.state]).sort()).toEqual([
          ['Alex', 'pending_add'],
          ['Steve', 'pending_remove'],
        ])
        for (const entry of pending) expect(entry.error).toContain('Cubepals will try again')
        expect(JSON.parse((await h.minecraft.file(server.id, 'whitelist.json')) ?? 'null')).toEqual([
          existing.player,
        ])
      } finally {
        refused.mockRestore()
      }

      expect(await h.app.reconciler.reconcile(server, handle, 'full')).toEqual({ restart: false })
      expect((await readAccess(h.db, server.id)).record.entries).toEqual([
        expect.objectContaining({ player: joining, state: 'active', error: null }),
      ])
      expect(JSON.parse((await h.minecraft.file(server.id, 'whitelist.json')) ?? 'null')).toEqual([joining])
    }, 60_000)
  }

  test('a failed whitelist switch cannot confirm restored access, and a retry completes it', async () => {
    const { server, handle } = await running()
    await h.db.transaction(async (tx) => {
      await lockServer(tx, server.id)
      await lockAccess(tx, server.id)
      await setWhitelistPending(tx, server.id, true)
      await markReseed(tx, server.id)
    })
    h.minecraft.refuseCommands(/^whitelist on$/)
    try {
      await expect(h.app.reconciler.reconcile(server, handle, 'full')).rejects.toBeInstanceOf(
        AccessReseedFailed,
      )
      expect((await readAccess(h.db, server.id)).record).toMatchObject({
        reseedRequired: true,
        whitelistEnabled: false,
        whitelistEnabledPending: true,
      })
      expect(await h.minecraft.file(server.id, 'server.properties')).toContain('white-list=false')
    } finally {
      h.minecraft.refuseCommands(null)
    }

    expect(await h.app.reconciler.reconcile(server, handle, 'full')).toEqual({ restart: false })
    expect((await readAccess(h.db, server.id)).record).toMatchObject({
      reseedRequired: false,
      whitelistEnabled: true,
      whitelistEnabledPending: null,
    })
    expect(await h.minecraft.file(server.id, 'server.properties')).toContain('white-list=true')
    expect(await h.minecraft.login(server.id, 'Stranger')).toBe('not whitelisted')
    expect(await h.minecraft.login(server.id, 'Steve')).toBe('joined')
  }, 60_000)
})
