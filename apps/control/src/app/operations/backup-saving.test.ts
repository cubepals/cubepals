// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A snapshot of a running server is taken with saving paused and the world flushed, and saving is
 * on again afterwards (world-copies.ts `capture`). A snapshot the game never said it had flushed
 * isn't offered as a restore point, and a server whose `save-on` didn't get through gets it again.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SAVE_ALL_FLUSH, SAVE_OFF, SAVE_ON } from '../../minecraft/console.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { listBackups } from '../backups/persistence.ts'
import type { ConsoleTarget, ServerConsole } from '../ports/minecraft.ts'
import { keepingSaving } from '../runtimes/owed-saving.ts'
import { NOT_SAVED_FIRST } from './handlers/world-copies.ts'

describe.skipIf(!hasDatabase)('a backup of a running server', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  test('whose flush never finished is kept failed, saying why, and not offered as a restore point', async () => {
    const owner = await h.user('Ines')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)

    // The flush outlives the console's wait, the second time too: runAll reports it failed.
    const runAll = h.minecraft.runAll.bind(h.minecraft)
    const flushTimedOut = spyOn(h.minecraft, 'runAll').mockImplementation(async (target, commands) => {
      const results = await runAll(
        target,
        commands.filter((c) => c !== 'save-all flush'),
      )
      return commands.map((c) =>
        c === 'save-all flush'
          ? { ok: false as const, error: 'The console stopped answering' }
          : (results.shift() ?? { ok: false as const, error: 'missing' }),
      )
    })
    try {
      await h.app.backups.createBackup(owner, id, randomUUID())
      await h.settled(id)
      expect(
        flushTimedOut.mock.calls.filter(([, commands]) => commands.includes('save-all flush')),
      ).toHaveLength(2)
    } finally {
      flushTimedOut.mockRestore()
    }
    const manual = (await listBackups(h.db, id)).filter((b) => b.trigger === 'manual')
    expect(
      manual.map((b) => ({ status: b.status, error: b.error, kept: b.snapshotHandle !== null })),
    ).toEqual([{ status: 'failed', error: NOT_SAVED_FIRST, kept: true }])
    expect(h.minecraft.heard(id).at(-1)).toBe(SAVE_ON)
  }, 60_000)

  test('sends a save-on the console dropped once again', async () => {
    const owner = await h.user('Oren')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)

    const run = h.minecraft.run.bind(h.minecraft)
    let dropped = 0
    const once = spyOn(h.minecraft, 'run').mockImplementation(async (target, command) => {
      if (command === 'save-on' && dropped === 0) {
        dropped++
        throw new Error('The connection dropped')
      }
      return run(target, command)
    })
    try {
      await h.app.backups.createBackup(owner, id, randomUUID())
      await h.settled(id)
    } finally {
      once.mockRestore()
    }
    const heard = h.minecraft.heard(id)
    expect(dropped).toBe(1)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(heard.lastIndexOf('save-on')).toBeGreaterThan(heard.lastIndexOf('save-off'))
    const backup = (await listBackups(h.db, id)).find((b) => b.trigger === 'manual')
    expect(backup?.status).toBe('ready')
  }, 60_000)
})

describe('a console still owed its save-on', () => {
  const target: ConsoleTarget = { endpoint: { host: 'game', port: 25575 }, passwords: ['secret'] }

  /** A console that drops every `save-on` while `dropping` holds, and remembers what it was sent. */
  const dropping = () => {
    const sent: string[] = []
    const state = { dropping: true }
    const inner: ServerConsole = {
      async run(_target, command) {
        if (command === SAVE_ON && state.dropping) throw new Error('The connection dropped')
        sent.push(command)
        return ''
      },
      async runAll(_target, commands) {
        return commands.map((command) => {
          sent.push(command)
          return { ok: true as const, output: '' }
        })
      },
    }
    return { sent, state, inner }
  }

  test('gets it before the next thing anything asks the server', async () => {
    const { sent, state, inner } = dropping()
    const kept = keepingSaving(inner)
    await expect(kept.run(target, SAVE_ON)).rejects.toThrow('The connection dropped')
    state.dropping = false
    await kept.runAll(target, ['list uuids'])
    await kept.run(target, 'list uuids')
    expect(sent).toEqual([SAVE_ON, 'list uuids', 'list uuids'])
  })

  test('is asked again next time when it drops that one too', async () => {
    const { sent, state, inner } = dropping()
    const kept = keepingSaving(inner)
    await expect(kept.run(target, SAVE_ON)).rejects.toThrow()
    await kept.run(target, 'list uuids')
    state.dropping = false
    await kept.run(target, 'list uuids')
    expect(sent).toEqual(['list uuids', SAVE_ON, 'list uuids'])
  })

  test('is not sent one while a snapshot has saving paused', async () => {
    const { sent, inner } = dropping()
    const kept = keepingSaving(inner)
    await expect(kept.run(target, SAVE_ON)).rejects.toThrow()
    await kept.runAll(target, [SAVE_OFF, SAVE_ALL_FLUSH])
    await kept.run(target, 'list uuids')
    expect(sent).toEqual([SAVE_OFF, SAVE_ALL_FLUSH, 'list uuids'])
  })

  test('is not sent one where saving went back on', async () => {
    const { sent, state, inner } = dropping()
    state.dropping = false
    const kept = keepingSaving(inner)
    await kept.run(target, SAVE_ON)
    await kept.run(target, 'list uuids')
    expect(sent).toEqual([SAVE_ON, 'list uuids'])
  })
})
