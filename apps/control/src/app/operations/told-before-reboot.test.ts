// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An update or a restart that reboots a server people are on tells them first: the console turns
 * them out with why, before the runtime takes the game down. A change the game takes live turns
 * nobody out, and a console that fails doesn't stop the reboot.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { RESTARTING, RESTARTING_FOR_A_CHANGE } from './handlers/restart-notice.ts'

describe.skipIf(!hasDatabase)('players told before a reboot', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterEach(() => {
    h.minecraft.refuseCommands(null)
  })

  afterAll(async () => {
    await h.close()
  })

  /** A running server with Alex on it. */
  const played = async () => {
    const owner = await h.user()
    const server = await h.create(owner, {})
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const alex = { uuid: randomUUID(), name: 'Alex' }
    h.minecraft.join(server.id, alex)
    return { owner, id: server.id, alex }
  }

  const change = async (owner: UserActor, id: string, settings: Record<string, unknown>) => {
    const current = (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
    const before = await h.server(id)
    await h.app.revisions.changeSettings(owner, id, { ...current, ...settings }, randomUUID())
    await h.until(
      id,
      (s) => s.lifecycle.status === 'running' && s.desiredRevisionId !== before.desiredRevisionId,
    )
    await h.settled(id)
  }

  const lastOf = async (id: string, kind: string) =>
    (await h.operations(id)).filter((op) => op.kind === kind).at(-1)

  /** What the console and the runtime were asked, in the order they were asked it. */
  const timeline = () => {
    const seen: string[] = []
    const runAll = h.minecraft.runAll.bind(h.minecraft)
    const consoleSpy = spyOn(h.minecraft, 'runAll').mockImplementation(async (target, commands) => {
      for (const command of commands) seen.push(`console: ${command}`)
      return runAll(target, commands)
    })
    const apply = h.runtime.apply.bind(h.runtime)
    const applySpy = spyOn(h.runtime, 'apply').mockImplementation(async (handle, spec) => {
      seen.push('runtime: apply')
      return apply(handle, spec)
    })
    const stop = h.runtime.stop.bind(h.runtime)
    const stopSpy = spyOn(h.runtime, 'stop').mockImplementation(async (handle) => {
      seen.push('runtime: stop')
      return stop(handle)
    })
    return {
      seen,
      restore: () => {
        consoleSpy.mockRestore()
        applySpy.mockRestore()
        stopSpy.mockRestore()
      },
    }
  }

  test('an update that reboots turns everyone out with why, before the runtime applies it', async () => {
    const { owner, id, alex } = await played()
    const watch = timeline()
    try {
      await change(owner, id, { viewDistance: 6 })
    } finally {
      watch.restore()
    }
    expect((await lastOf(id, 'apply'))?.status).toBe('succeeded')
    expect(h.minecraft.kickedWith(id, alex.uuid)).toBe(RESTARTING_FOR_A_CHANGE)
    const kicked = watch.seen.indexOf(`console: minecraft:kick @a ${RESTARTING_FOR_A_CHANGE}`)
    expect(kicked).toBeGreaterThanOrEqual(0)
    expect(watch.seen.indexOf('runtime: apply')).toBeGreaterThan(kicked)
  }, 60_000)

  test('a change taken live turns nobody out', async () => {
    const { owner, id, alex } = await played()
    const watch = timeline()
    try {
      await change(owner, id, { difficulty: 'hard' })
    } finally {
      watch.restore()
    }
    expect((await lastOf(id, 'apply'))?.status).toBe('succeeded')
    expect(watch.seen).not.toContain('runtime: apply')
    expect(watch.seen.some((line) => line.includes('kick'))).toBe(false)
    expect(h.minecraft.kickedWith(id, alex.uuid)).toBeUndefined()
    expect(h.minecraft.playing(id)?.difficulty).toBe('hard')
  }, 60_000)

  test('a restart turns everyone out with why, before the runtime stops the server', async () => {
    const { owner, id, alex } = await played()
    const watch = timeline()
    const before = await h.server(id)
    try {
      await h.app.servers.restart(owner, id, randomUUID())
      await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version)
      await h.settled(id)
    } finally {
      watch.restore()
    }
    expect((await lastOf(id, 'restart'))?.status).toBe('succeeded')
    expect(h.minecraft.kickedWith(id, alex.uuid)).toBe(RESTARTING)
    const kicked = watch.seen.indexOf(`console: minecraft:kick @a ${RESTARTING}`)
    expect(kicked).toBeGreaterThanOrEqual(0)
    expect(watch.seen.indexOf('runtime: stop')).toBeGreaterThan(kicked)
  }, 60_000)

  test('a console that refuses the kick still lets the update reboot', async () => {
    const { owner, id, alex } = await played()
    h.minecraft.refuseCommands(/kick/)
    await change(owner, id, { viewDistance: 7 })
    expect((await lastOf(id, 'apply'))?.status).toBe('succeeded')
    expect(h.minecraft.kickedWith(id, alex.uuid)).toBeUndefined()
  }, 60_000)
})
