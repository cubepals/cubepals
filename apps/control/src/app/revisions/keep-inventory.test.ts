// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeping items on death, end to end: the owner's one setting reaches a running Paper server in
 * every dimension as people play, holds through a stop, a console that changed it and a new world,
 * and a settings page from before it leaves the choice alone. What the commands are is
 * `minecraft/settings.test.ts`'s; how the game keeps its rules is the fake's (`fake-minecraft/game-rules.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { ServerSettings } from '../../domain/revision/revision.ts'
import { type Harness, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision, loadRuntime } from '../servers/persistence.ts'

const DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end']

describe('keeping items on death', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async (name: string) => {
    const owner = await h.user()
    const server = await h.create(owner, { name, gameVersion: '26.2' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const settingsOf = async (id: string) =>
    (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
  const change = async (owner: UserActor, id: string, patch: Partial<ServerSettings>) => {
    await h.app.revisions.changeSettings(owner, id, { ...(await settingsOf(id)), ...patch }, randomUUID())
    await h.settled(id)
  }
  const keeps = (id: string) => DIMENSIONS.map((dimension) => h.minecraft.keepsInventory(id, dimension))
  const applied = async (id: string) => (await loadRuntime(h.db, id, ['fake'])).applied

  test('reaches every dimension as people play, and holds through a stop, a console and a new world', async () => {
    const { owner, id } = await running('Keepers')
    // On Paper, where each dimension keeps its own rules; never chosen is off, as Minecraft has it.
    expect(h.runtime.machine(id)?.spec.env.TYPE).toBe('PAPER')
    expect(keeps(id)).toEqual([false, false, false])
    const ran = await applied(id)
    await change(owner, id, { keepInventory: true })
    expect(keeps(id)).toEqual([true, true, true])
    // Taken as people play: the server runs the new revision, and nothing restarted.
    expect((await applied(id))?.revisionId).toBe((await h.server(id)).desiredRevisionId)
    expect((await applied(id))?.specDigest).toBe(ran?.specDigest)
    expect(await settingsOf(id)).toMatchObject({ keepInventory: true })

    // A console that turns it off sets the overworld alone.
    expect(await h.app.console.run(owner, id, 'gamerule keep_inventory false')).toBe(
      'Gamerule keep_inventory is now set to: false',
    )
    // The console shows the game's own answer, which says when a command ran nothing.
    expect(await h.app.console.run(owner, id, 'gamerule keep_invmentory true')).toBe(
      'Incorrect argument for command\ngamerule keep_invmentory true<--[HERE]',
    )
    expect(keeps(id)).toEqual([false, true, true])
    // The next start puts the setting back everywhere.
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(keeps(id)).toEqual([true, true, true])

    // A new world starts at the game's defaults, and is set as it opens.
    const first = (await h.server(id)).activeWorldId
    await h.app.worlds.freshStart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.activeWorldId !== first)
    await h.settled(id)
    expect(keeps(id)).toEqual([true, true, true])

    await change(owner, id, { keepInventory: false })
    expect(keeps(id)).toEqual([false, false, false])
    await h.app.servers.deleteServer(owner, id, 'Keepers')
  }, 30_000)

  test('a settings page from before it leaves the choice as it was', async () => {
    const { owner, id } = await running('Unchanged')
    await change(owner, id, { keepInventory: true })
    const { keepInventory: _left, ...older } = await settingsOf(id)
    await h.app.revisions.changeSettings(owner, id, { ...older, difficulty: 'hard' }, randomUUID())
    await h.settled(id)
    expect(await settingsOf(id)).toMatchObject({ difficulty: 'hard', keepInventory: true })
    await h.app.servers.deleteServer(owner, id, 'Unchanged')
  })
})
