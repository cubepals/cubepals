// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server rebuilt off a lost host starts from the newest ready snapshot of its volume, whatever
 * world that snapshot was recorded under. An owner who switched worlds while the server slept
 * keeps everything played since, on every world.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { listBackups } from '../backups/persistence.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'
import { HOST_LOSS_GRACE_MS } from './schedules.ts'

describe.skipIf(!hasDatabase)('a lost host rebuilt after a world switch while asleep', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  test('is rebuilt from the newest snapshot of its volume, not an older one of the world it switched to', async () => {
    const owner = await h.user('Pia')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const first = (await h.server(id)).activeWorldId ?? ''

    // A second world, played a while and backed up, then the first again.
    const withB = await h.app.worlds.createWorld(
      owner,
      id,
      { name: 'Creative', levelType: 'minecraft:normal', hardcore: false },
      randomUUID(),
    )
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    const second = withB.activeWorldId ?? ''
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    await h.app.worlds.switchWorld(owner, id, first, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)

    // Weeks of play on the first world, kept by a backup taken after it.
    const dir = () => h.runtime.machine(id)?.dir ?? ''
    await writeFile(join(dir(), 'world', 'built.txt'), 'weeks of play')
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    // Asleep, the owner picks the other world for next time.
    await h.app.worlds.switchWorld(owner, id, second, randomUUID())
    await h.settled(id)
    const levelOf = (await listWorlds(h.db, id)).find((w) => w.id === first)?.levelName

    const snaps = (await listBackups(h.db, id)).filter((b) => b.tier === 'snapshot' && b.status === 'ready')
    const newest = snaps.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]

    await h.runtime.loseHost(id)
    await h.app.schedules.reconcile()
    const lost = (await loadRuntime(h.db, id, ['fake'])).observed
    const later = new Date(Date.parse(lost?.at ?? '') + HOST_LOSS_GRACE_MS + 1_000)
    expect(await h.app.schedules.relocations(later)).toBe(1)
    await h.until(id, (s) => s.lifecycle.status !== 'relocating', 20_000)
    await h.settled(id, 20_000)

    const [rebuilt] = await h.db.query.auditLog.findMany({
      where: (a, { and, eq }) => and(eq(a.subjectId, id), eq(a.action, 'server.rebuilt_from_backup')),
    })
    const played = await readFile(join(dir(), levelOf ?? 'world', 'built.txt'), 'utf8').catch(() => null)
    expect((rebuilt?.data as { backupId?: string } | undefined)?.backupId).toBe(newest?.id)
    expect(played).toBe('weeks of play')
  }, 120_000)
})
