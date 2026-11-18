// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A start that stops on a file its output names: which file may be set aside, and the start that
 * sets it aside, comes up, and puts it back when its owner asks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { chooseAside, loadSetAside } from './set-aside.ts'

const jar = (fileName: string) => ({ artifact: { fileName }, loaders: ['fabric'] }) as unknown as PinnedMod
const fabric = (...names: string[]) => ({ loader: 'fabric' as const, mods: names.map(jar) })

describe('which named file may be set aside', () => {
  test('a datapack Blockly didn’t put there', () => {
    const owners = { path: 'datapacks/far-end.zip', inWorld: true }
    expect(chooseAside([owners], fabric())).toEqual(owners)
    // One of Blockly's own, named by its bytes, goes back at every start.
    expect(chooseAside([{ path: 'datapacks/0123456789ab-manhunt.zip', inWorld: true }], fabric())).toBeNull()
  })

  test('of two copies of a mod, the one the revision doesn’t place', () => {
    const files = [
      { path: 'mods/jei-19.21.jar', inWorld: false },
      { path: 'mods/jei-19.19.jar', inWorld: false },
    ]
    expect(chooseAside(files, fabric('jei-19.21.jar'))).toEqual({
      path: 'mods/jei-19.19.jar',
      inWorld: false,
    })
    // Both the revision's, or neither: nothing tells which is the owner's, so nothing moves.
    expect(chooseAside(files, fabric('jei-19.21.jar', 'jei-19.19.jar'))).toBeNull()
    expect(chooseAside(files, fabric())).toBeNull()
  })
})

const broken = 'java.lang.IllegalStateException: Failed to parse minecraft:the_end from pack file/far-end.zip'

describe.skipIf(!hasDatabase)('a start that stops on a datapack', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    h.minecraft.breakOn(() => null)
    await h.close()
  })

  test('sets it aside, comes up, says so, and puts it back when asked', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Far End' })
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    // The datapack breaks every start it is still in the world for.
    h.minecraft.breakOn((env) =>
      env.BLOCKLY_SET_ASIDE?.includes('aside world datapacks/far-end.zip') ? null : broken,
    )
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running', 30_000)
    expect(await loadSetAside(h.db, id)).toMatchObject([
      { path: 'datapacks/far-end.zip', inWorld: true, back: false, why: expect.stringContaining('far-end') },
    ])
    expect((await h.app.queries.get(owner, id)).setAside).toHaveLength(1)
    expect(h.runtime.machine(id)?.spec.env.BLOCKLY_SET_ASIDE).toBe('aside world datapacks/far-end.zip')

    // Put back: at the next start, and only then is it off the list.
    await h.app.servers.setAside.putBack(owner, id, 'datapacks/far-end.zip', true)
    expect((await h.app.queries.get(owner, id)).setAside?.[0]?.back).toBe(true)
    h.minecraft.breakOn(() => null)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running', 30_000)
    expect(await loadSetAside(h.db, id)).toEqual([])
  }, 90_000)

  test('a file set aside once that is named again fails with its remedy, not a loop', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Still Broken' })
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    h.minecraft.breakOn(() => broken)
    await h.app.servers.start(owner, id, randomUUID())
    const failed = await h.until(id, 'failed', 60_000)
    expect(failed.lifecycle.failure?.remedy).toBe('mods')
    expect(await loadSetAside(h.db, id)).toHaveLength(1)
  }, 90_000)
})
