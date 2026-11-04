// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world that outgrows its disk while people play (`schedules/disk-growth.ts`): with room left,
 * the bigger disk waits for its next start and nobody is turned out; only a disk about to fill
 * restarts the server onto the bigger one now, its players told why. Free disks never grow.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { entitlementsFor, grownDisk, growthLineBytes } from '../../domain/account/entitlements.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { grownStorage } from '../servers/persistence.ts'
import { RESTARTING } from './handlers/restart-notice.ts'

const GB = 2 ** 30

describe.skipIf(!hasDatabase)('disks that grow while people play', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const plus = entitlementsFor('plus')
  const first = plus.storage.startGb
  /** Past the line its first disk grows at, with far more than a gigabyte of it left. */
  const pastTheLine = growthLineBytes(first) + GB / 10

  /** A Plus server running on its first disk, with Alex playing on it. */
  const played = async (name: string) => {
    const owner = await h.user(name, 'plus')
    const { id } = await h.create(owner, { name })
    await h.until(id, 'running')
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.storage.sizeGb).toBe(first)
    const alex = { uuid: randomUUID(), name: 'Alex' }
    h.minecraft.join(id, alex)
    return { owner, id, alex }
  }

  /** What `du` says the world takes, and `df` of the disk it is on; null: what is really there. */
  const takes = (id: string, bytes: number | null) =>
    h.runtime.reportDiskUsage(id, bytes === null ? null : Math.round(bytes / 1024))

  /** Waits for a restart of the server, from how it is now, to be done. */
  const restarted = async (id: string, before: { version: number }) => {
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version, 60_000)
    await h.settled(id, 30_000)
  }

  test('a world past where its disk grows plays on, and gets the bigger disk at its next start', async () => {
    const { owner, id, alex } = await played('Explorer')
    const bigger = grownDisk(plus, first, pastTheLine)
    expect(bigger).toBeGreaterThan(first)
    try {
      takes(id, pastTheLine)
      expect(await h.app.schedules.diskCheck()).toBe(0)
      expect(await h.app.schedules.diskCheck()).toBe(0)
      // Nobody is turned out or told anything; the bigger disk is recorded for its next start.
      expect(h.runtime.machine(id)?.state).toBe('running')
      expect(h.runtime.machine(id)?.spec.storage.sizeGb).toBe(first)
      expect(h.minecraft.kickedWith(id, alex.uuid)).toBeUndefined()
      expect(h.minecraft.said(id).some((line) => line.includes('out of room'))).toBe(false)
      expect(await grownStorage(h.db, id)).toBe(bigger ?? Number.NaN)
    } finally {
      takes(id, null)
    }
    const before = await h.server(id)
    await h.app.servers.restart(owner, id, randomUUID())
    await restarted(id, before)
    expect(h.runtime.machine(id)?.spec.storage.sizeGb).toBe(bigger ?? Number.NaN)
  }, 90_000)

  test('a world about to fill the disk it is on restarts onto the bigger one now, its players told why', async () => {
    const { id, alex } = await played('Far Lands')
    try {
      // Past the line first: recorded, and it plays on.
      takes(id, pastTheLine)
      expect(await h.app.schedules.diskCheck()).toBe(0)
      const bigger = await grownStorage(h.db, id)
      expect(bigger).toBeGreaterThan(first)
      // Then half a gigabyte left on the disk it is still on: told why, turned out, and back on the
      // bigger one, though what was recorded already says that one has room.
      takes(id, first * GB - GB / 2)
      const before = await h.server(id)
      expect(await h.app.schedules.diskCheck()).toBe(1)
      await restarted(id, before)
      expect(h.runtime.machine(id)?.spec.storage.sizeGb).toBe(bigger)
      expect(h.minecraft.said(id).some((line) => line.includes('almost out of room'))).toBe(true)
      expect(h.minecraft.kickedWith(id, alex.uuid)).toBe(RESTARTING)
      // Measured again on the disk it has now: room, so nothing more.
      expect(await h.app.schedules.diskCheck()).toBe(0)
    } finally {
      takes(id, null)
    }
  }, 90_000)

  test('a free server’s disk never grows, so it is never restarted for room', async () => {
    const free = entitlementsFor('free')
    const owner = await h.user('Walker')
    const { id } = await h.create(owner, { name: 'Small Lands' })
    await h.until(id, 'running')
    await h.settled(id)
    try {
      takes(id, free.storage.mostGb * GB - GB / 2)
      expect(await h.app.schedules.diskCheck()).toBe(0)
      expect(await grownStorage(h.db, id)).toBe(0)
    } finally {
      takes(id, null)
    }
  }, 60_000)
})
