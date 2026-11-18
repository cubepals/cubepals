// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A new world's spawn warmed after its first boot, against the fake game's own `forceload`: queued
 * by the boot, never left force-loaded, and never touching a world someone is on or a force-load
 * its owner set.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { forcedChunks, stallChunks } from '../../infra/fake/fake-minecraft/chunks.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { RuntimeRouter } from '../runtimes/router.ts'
import { serverBinding } from './handlers/binding.ts'
import { gameConsole } from './handlers/game-console.ts'
import { insertOperation, recordMark } from './persistence.ts'
import type { OperationContext } from './runner.ts'
import {
  FORCELOAD_ADD,
  FORCELOAD_REMOVE,
  forcedCount,
  warmingAfterBoot,
  warmingSpawn,
} from './spawn-warm-up.ts'

let harness: ReturnType<typeof startHarness> | undefined
afterAll(async () => {
  await harness?.then(
    (h) => h.close(),
    () => undefined,
  )
}, 30 * SECOND_MS)

/** The marks an operation's attempts left, in order. */
async function marksOf(h: Awaited<ReturnType<typeof startHarness>>, operationId: string) {
  const [row] = await h.db
    .select({ steps: schema.serverOperations.steps })
    .from(schema.serverOperations)
    .where(eq(schema.serverOperations.id, operationId))
  return ((row?.steps ?? []) as Array<{ step: string }>)
    .map((s) => s.step)
    .filter((s) => s.startsWith('spawn:'))
}

/** Another warm-up of the same world, a real operation whose marks are kept on it. */
async function anotherOf(h: Awaited<ReturnType<typeof startHarness>>, ctx: OperationContext) {
  const { record } = await h.db.transaction((tx) =>
    insertOperation(tx, {
      serverId: ctx.server.id,
      kind: 'warm_spawn',
      input: {},
      requestedBy: 'system:warm',
      idempotencyKey: `${ctx.op.idempotencyKey}:2`,
    }),
  )
  return { ...ctx, op: record, mark: (mark: string) => recordMark(h.db, record.id, mark) }
}

/** A server whose first boot and its warm-up are done, and the warm-up handler to run again. */
async function warmed(options: { waitMs?: number } = {}) {
  harness ??= startHarness()
  const h = await harness
  const created = await h.create(await h.user(), { gameVersion: '26.3' })
  const server = await h.until(created.id, 'running')
  const ops = await h.settled(server.id)
  const runtime = new RuntimeRouter([...h.runtimes.values()])
  const binding = serverBinding({ db: h.db, runtime, jobs: h.jobs })
  const game = gameConsole({ runtime, specs: h.app.specs, console: h.minecraft, access: h.app.reconciler })
  const handler = warmingSpawn({
    db: h.db,
    console: h.minecraft,
    consoleTarget: game.consoleTarget,
    bindingOf: binding.bindingOf,
    pollMs: 0,
    ...options,
  })
  const warmOp = ops.find((op) => op.kind === 'warm_spawn')
  if (warmOp === undefined) throw new Error('A new server’s first boot queues its warm-up')
  const marks: string[] = []
  const ctx: OperationContext = {
    signal: new AbortController().signal,
    server,
    op: warmOp,
    step: async () => {},
    mark: async (mark) => {
      marks.push(mark)
    },
    reached: () => null,
    stillApplies: async () => true,
  }
  const { handle } = await binding.bindingOf(server.id)
  if (handle === null) throw new Error('A running server has a handle')
  const target = game.consoleTarget(server, handle)
  return { h, server, ops, handler, ctx, marks, target, dir: h.minecraft.path(server.id, '') }
}

describe.skipIf(!hasDatabase)('a new world’s spawn', () => {
  test('is generated after its first boot, and left with no force-load', async () => {
    const { h, server, ops, dir } = await warmed()
    const warm = ops.find((op) => op.kind === 'warm_spawn')
    expect(warm?.status).toBe('succeeded')
    expect(warm?.requestedBy).toBe('system:warm')
    const heard = h.minecraft.heard(server.id)
    expect(heard.indexOf(FORCELOAD_ADD)).toBeGreaterThan(-1)
    expect(heard.indexOf(FORCELOAD_REMOVE)).toBeGreaterThan(heard.indexOf(FORCELOAD_ADD))
    expect(heard.filter((line) => line.startsWith('execute if loaded')).length).toBeGreaterThanOrEqual(49)
    expect(forcedChunks(dir)).toEqual([])
    expect(await marksOf(h, warm?.id ?? '')).toEqual(['spawn:forced', 'spawn:ready'])
  })

  test('is left alone while someone is on', async () => {
    const { h, server, handler, ctx, marks } = await warmed()
    h.minecraft.join(server.id, { uuid: '00000000-0000-0000-0000-000000000001', name: 'Steve' })
    const before = h.minecraft.heard(server.id).length
    expect(await handler.run(ctx)).toEqual({ status: 'succeeded' })
    expect(h.minecraft.heard(server.id).slice(before)).not.toContain(FORCELOAD_ADD)
    expect(marks).toEqual(['spawn:players_on'])
  })

  test('keeps a force-load its owner set, and adds none', async () => {
    const { h, server, handler, ctx, marks, target, dir } = await warmed()
    await h.minecraft.run(target, 'forceload add 320 320')
    const before = h.minecraft.heard(server.id).length
    await handler.run(ctx)
    const heard = h.minecraft.heard(server.id).slice(before)
    expect(heard).not.toContain(FORCELOAD_ADD)
    expect(heard).not.toContain(FORCELOAD_REMOVE)
    expect(forcedChunks(dir)).toEqual(['20,20'])
    expect(marks).toEqual(['spawn:owner_forced'])
  })

  test('cut short, is finished and taken off by the next attempt', async () => {
    const { h, handler, ctx, target, dir } = await warmed()
    const attempt = await anotherOf(h, ctx)
    await recordMark(h.db, attempt.op.id, 'spawn:forced')
    await h.minecraft.run(target, FORCELOAD_ADD)
    expect(forcedChunks(dir)).toHaveLength(49)
    await handler.run(attempt)
    expect(forcedChunks(dir)).toEqual([])
    expect(await marksOf(h, attempt.op.id)).toEqual(['spawn:forced', 'spawn:ready'])
  })

  test('not loaded in time, is still taken off', async () => {
    const { h, server, handler, ctx, marks, dir } = await warmed({ waitMs: 0 })
    const before = h.minecraft.heard(server.id).length
    stallChunks(dir, true)
    try {
      await handler.run({ ...ctx, op: { ...ctx.op, id: randomUUID(), idempotencyKey: 'warm_spawn:unready' } })
    } finally {
      stallChunks(dir, false)
    }
    expect(h.minecraft.heard(server.id).slice(before)).toContain(FORCELOAD_ADD)
    expect(forcedChunks(dir)).toEqual([])
    expect(marks).toEqual(['spawn:forced', 'spawn:unready'])
  })

  test('left on with the console unreadable, fails until an attempt takes it off', async () => {
    const { h, server, handler, ctx, target, dir } = await warmed()
    const attempt = await anotherOf(h, ctx)
    await recordMark(h.db, attempt.op.id, 'spawn:forced')
    await h.minecraft.run(target, FORCELOAD_ADD)
    h.minecraft.refuseCommands(/^forceload query$/)
    try {
      await expect(handler.run(attempt)).rejects.toThrow()
      expect(forcedChunks(dir)).toHaveLength(49)
    } finally {
      h.minecraft.refuseCommands(null)
    }
    expect(await handler.run(attempt)).toEqual({ status: 'succeeded' })
    expect(forcedChunks(dir)).toEqual([])
  })

  test('keeps an owner’s own square around spawn, which no attempt said it added', async () => {
    const { h, server, handler, ctx, marks, target, dir } = await warmed()
    await h.minecraft.run(target, FORCELOAD_ADD)
    const before = h.minecraft.heard(server.id).length
    // A warm-up of another world switched to, whose attempts never added one.
    await handler.run({ ...ctx, op: { ...ctx.op, id: randomUUID() } })
    expect(h.minecraft.heard(server.id).slice(before)).not.toContain(FORCELOAD_REMOVE)
    expect(forcedChunks(dir)).toHaveLength(49)
    expect(marks).toEqual(['spawn:owner_forced'])
  })
})

describe.skipIf(!hasDatabase)('the warm-up is queued', () => {
  const warmUps = async (h: Awaited<ReturnType<typeof startHarness>>, serverId: string) =>
    (await h.settled(serverId)).filter((op) => op.kind === 'warm_spawn')

  test('once for a world, not again when it boots again', async () => {
    const { h, server } = await warmed()
    const [{ applied } = { applied: null }] = await h.db
      .select({ applied: schema.serverRuntimes.applied })
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, server.id))
    if (applied === null) throw new Error('A booted server has what it runs')
    const queue = warmingAfterBoot(h.app.transitions)
    await h.db.transaction((tx) => queue(tx, server.id, applied))
    await h.db.transaction((tx) => queue(tx, server.id, { ...applied, worldId: server.activeWorldId }))
    expect(await warmUps(h, server.id)).toHaveLength(1)
  })

  test('again at the next boot of its world, where one never got to run', async () => {
    const { h, server, ops } = await warmed()
    const [{ applied } = { applied: null }] = await h.db
      .select({ applied: schema.serverRuntimes.applied })
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, server.id))
    if (applied === null) throw new Error('A booted server has what it runs')
    const queue = warmingAfterBoot(h.app.transitions)
    const first = ops.find((op) => op.kind === 'warm_spawn')?.idempotencyKey ?? 'none'
    const cancel = () =>
      h.db
        .update(schema.serverOperations)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(schema.serverOperations.serverId, server.id),
            eq(schema.serverOperations.kind, 'warm_spawn'),
          ),
        )
    await cancel()
    for (let i = 0; i < 4; i++) {
      await h.db.transaction((tx) => queue(tx, server.id, applied))
      await h.settled(server.id)
      await cancel()
    }
    const all = await warmUps(h, server.id)
    expect(all.map((op) => op.idempotencyKey)).toEqual([
      first,
      `warm_spawn:${applied.worldId}:2`,
      `warm_spawn:${applied.worldId}:3`,
    ])
  })

  test('not where the game prepares its spawn as it starts', async () => {
    harness ??= startHarness()
    const h = await harness
    const created = await h.create(await h.user(), { gameVersion: '1.21.8' })
    await h.until(created.id, 'running')
    expect(await warmUps(h, created.id)).toEqual([])
  })
})

test('reads what forceload query says, in 26.3’s words', () => {
  expect(forcedCount('No force loaded chunks were found in minecraft:overworld')).toBe(0)
  expect(forcedCount('A force loaded chunk was found in minecraft:overworld at: [1, 2]')).toBe(1)
  expect(forcedCount('49 force loaded chunks were found in minecraft:overworld at: [-3, -3], …')).toBe(49)
  expect(forcedCount('Unknown or incomplete command')).toBeNull()
})
