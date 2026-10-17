// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world woken from rest and put to rest again comes back as it was when it last slept, whatever
 * changed it in between: a short visit, a restore. Each rest makes its own copy.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { levelDat } from '../../testing/uploads.ts'
import { listBackups } from '../backups/persistence.ts'

const run = promisify(execFile)

describe.skipIf(!hasDatabase)('resting again after a wake', () => {
  let h: Harness
  let scratch: string
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    scratch = await mkdtemp(join(tmpdir(), 'resting-again-'))
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
    await rm(scratch, { recursive: true, force: true })
  })

  const built = (id: string) => h.minecraft.path(id, 'world/built.txt')
  const castle = (id: string) => readFile(built(id), 'utf8')
  const idleFor = (id: string, days: number) =>
    h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - days * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))
  const tarball = async (files: Record<string, string | Uint8Array>) => {
    const dir = join(scratch, randomUUID())
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, 'volume', path, '..'), { recursive: true })
      await writeFile(join(dir, 'volume', path), content)
    }
    await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'volume'), '.'])
    return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
  }

  test('a short visit on a woken world survives its next rest', async () => {
    const owner = await h.user('Quinn')
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await writeFile(built(id), 'the castle')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await idleFor(id, 15)
    await h.app.schedules.storeSweep()
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)

    // A friend joins: the join wakes it from rest.
    await h.app.edge.wake(`${slug}.play.test`)
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    // They are in for under a minute, between two presence readings, and build a tower.
    const friend = { name: 'Rowan', uuid: randomUUID() }
    h.minecraft.join(id, friend)
    const hostname = `${slug}.play.test`
    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname,
      event: 'connect',
      player: friend,
      at: new Date().toISOString(),
    })
    await writeFile(built(id), 'the castle, and a tower')
    h.minecraft.leave(id, friend.uuid)
    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname,
      event: 'disconnect',
      player: friend,
      at: new Date().toISOString(),
    })

    // It goes to sleep the ordinary way, its world saved.
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 6 * MINUTE_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), sql`${schema.powerIntervals.stoppedAt} is null`))
    await h.app.schedules.idleCheck(new Date(Date.now() + 10 * MINUTE_MS))
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(await castle(id)).toBe('the castle, and a tower')

    // The hourly sweep rests it again, in a copy of its own.
    await h.app.schedules.storeSweep()
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    const copies = (await listBackups(h.db, id)).filter((b) => b.tier === 'archive' && b.trigger === 'stored')
    expect(copies).toHaveLength(2)

    // The owner wakes it later: the tower is there.
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status !== 'restoring' && s.lifecycle.status !== 'stored', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await castle(id)).toBe('the castle, and a tower')
  }, 90_000)

  test('the restored world is what comes back from the next rest', async () => {
    const owner = await h.user('Wren')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    // A world of the owner's, brought back as a backup to restore later.
    const bytes = await tarball({
      'server.properties': 'level-name=world\n',
      'world/level.dat': levelDat('26.3'),
      'world/built.txt': 'the castle the owner restored',
    })
    const start = await h.app.backups.beginWorldUpload(owner, id, {
      fileName: 'w.tar.gz',
      sizeBytes: bytes.length,
    })
    await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
    const uploaded = await h.app.backups.finishWorldUpload(owner, id, start.ticket)

    await writeFile(built(id), 'the griefed castle')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await idleFor(id, 15)
    await h.app.schedules.storeSweep()
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)

    // A connection wakes it (a server-list ping, a knock): not play, so lastActiveAt stays.
    await h.app.servers.start({ kind: 'system', reason: 'wake' }, id, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    // The owner, seeing it up, restores their own world over the griefed one.
    await h.app.backups.restoreBackup(owner, id, uploaded.id, randomUUID(), { withConfiguration: false })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect(await castle(id)).toBe('the castle the owner restored')

    // Nobody joins; it sleeps, and rests again.
    await h.app.servers.stop({ kind: 'system', reason: 'idle' }, id, randomUUID(), 'idle')
    await h.until(id, 'stopped', 20_000)
    await h.settled(id, 20_000)
    await h.app.schedules.storeSweep()
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)

    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await castle(id)).toBe('the castle the owner restored')
  }, 120_000)
})
