// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A restore the provider had no machine for, end to end (§9, §19.12): the queue tries it again
 * later, rather than the restore going back to the world it would replace.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { RuntimeAtLimit } from '../ports/runtime.ts'
import { listBackups } from './persistence.ts'

describe.skipIf(!hasDatabase)('a restore at the provider’s machine limit', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('is tried again by the queue, not rolled back, and restores the world', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const marker = () => h.minecraft.path(id, 'world/built.txt')
    await writeFile(marker(), 'the castle before')
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const backup = (await listBackups(h.db, id)).find((b) => b.trigger === 'manual' && b.status === 'ready')
    if (backup === undefined) throw new Error('No backup was taken')
    await writeFile(marker(), 'the castle, griefed')

    const atLimit = spyOn(h.runtime, 'restore').mockImplementationOnce(async () => {
      throw new RuntimeAtLimit('fake', 'no machine freed meanwhile')
    })
    let calls = 0
    try {
      await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
      await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
      await h.settled(id, 20_000)
      calls = atLimit.mock.calls.length
    } finally {
      atLimit.mockRestore()
    }

    // Refused once, then the queue's second attempt restored it.
    expect(calls).toBe(2)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await readFile(marker(), 'utf8')).toBe('the castle before')
    const restore = (await h.operations(id)).filter((op) => op.kind === 'restore').at(-1)
    expect(restore).toMatchObject({ status: 'succeeded' })
  }, 30_000)
})
