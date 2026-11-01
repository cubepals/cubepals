// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Handler boundary checks use real persisted bindings, game files and provider exec results. */
import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { resetHeartsCommand } from '../../../minecraft/lifesteal.ts'
import { hasDatabase, startHarness } from '../../../testing/harness.ts'
import { RuntimeRouter } from '../../runtimes/router.ts'
import { NoLongerApplies, type OperationContext } from '../runner.ts'
import { serverBinding } from './binding.ts'
import { gameConsole } from './game-console.ts'
import { goingBack } from './going-back.ts'
import { rechecks } from './rechecks.ts'
import { updating } from './updating.ts'
import { worldCopies } from './world-copies.ts'

async function fixture() {
  const h = await startHarness()
  try {
    const owner = await h.user()
    const created = await h.create(owner)
    const server = await h.until(created.id, 'running')
    const [operation] = await h.settled(server.id)
    if (!operation) throw new Error('Provisioning must leave an operation')
    const runtime = new RuntimeRouter([...h.runtimes.values()])
    const binding = serverBinding({ db: h.db, runtime, jobs: h.jobs })
    const game = gameConsole({ runtime, specs: h.app.specs, console: h.minecraft, access: h.app.reconciler })
    const common = { db: h.db, runtime, specs: h.app.specs, boot: h.app.boot, transitions: h.app.transitions }
    const back = goingBack({ ...common, ...binding, access: h.app.reconciler })
    const checks = rechecks({ db: h.db, policy: h.app.policy, artifacts: h.app.artifacts })
    const copies = worldCopies({
      db: h.db,
      runtime,
      console: h.minecraft,
      consoleTarget: game.consoleTarget,
      events: h.events,
      archives: null,
      backups: h.app.backups,
    })
    const deps = {
      ...common,
      ...binding,
      ...back,
      ...checks,
      console: h.minecraft,
      artifacts: h.app.artifacts,
      backups: h.app.backups,
      consoleTarget: game.consoleTarget,
      capture: copies.capture,
    }
    const steps: Parameters<OperationContext['step']>[0][] = []
    const ctx: OperationContext = {
      server,
      op: { ...operation, kind: 'apply', input: { boot: true } },
      step: async (step) => {
        steps.push(step)
      },
      mark: async () => {},
      reached: () => null,
      stillApplies: async () => true,
    }
    return { h, server, runtime, binding, deps, ctx, steps }
  } catch (error) {
    await h.close()
    throw error
  }
}

async function missingBinding() {
  const { h, server, deps, ctx } = await fixture()
  try {
    await h.db
      .update(schema.serverRuntimes)
      .set({ handle: null })
      .where(eq(schema.serverRuntimes.serverId, server.id))
    await expect(updating(deps).run(ctx)).rejects.toThrow('nothing running to update')
  } finally {
    await h.close()
  }
}

async function missingApplied() {
  const { h, server, deps, ctx } = await fixture()
  try {
    await h.db
      .update(schema.serverRuntimes)
      .set({ applied: null })
      .where(eq(schema.serverRuntimes.serverId, server.id))
    await expect(updating(deps).run(ctx)).rejects.toThrow('nothing running to update')
  } finally {
    await h.close()
  }
}

async function refusesBoot() {
  const { h, server, deps, ctx } = await fixture()
  try {
    const result = await updating({
      ...deps,
      mayBoot: async () => ({ up: false, refusal: 'The owner may not run this server.' }),
    }).run(ctx)
    expect(result).toEqual({
      status: 'failed',
      reason: 'The server stayed off: The owner may not run this server.',
    })
    expect(h.runtime.machine(server.id)?.state).toBe('stopped')
  } finally {
    await h.close()
  }
}

async function resetsHearts() {
  const { h, server, deps, ctx } = await fixture()
  try {
    const path = h.minecraft.path(server.id, 'plugins/LifeStealZ/userData.db')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'last season')
    await writeFile(`${path}-wal`, 'last uncheckpointed hearts')
    await writeFile(`${dirname(path)}/config.yml`, 'startHearts: 10')
    ctx.op.input = { boot: true, resetHearts: true }
    expect(await updating(deps).run(ctx)).toEqual({ status: 'succeeded' })
    await expect(readFile(path)).rejects.toThrow()
    await expect(readFile(`${path}-wal`)).rejects.toThrow()
    expect(await readFile(`${dirname(path)}/config.yml`, 'utf8')).toBe('startHearts: 10')
  } finally {
    await h.close()
  }
}

async function refusesCorruptHearts() {
  const { h, server, runtime, binding, deps, ctx, steps } = await fixture()
  try {
    const path = h.minecraft.path(server.id, 'plugins/LifeStealZ/userData.db')
    await mkdir(path, { recursive: true })
    const { handle } = await binding.bindingOf(server.id)
    if (!handle) throw new Error('The binding must remain running')
    const refused = await runtime.exec(handle, resetHeartsCommand(), 60)
    expect(refused.exitCode).not.toBe(0)
    let rolledBack = false
    ctx.op.input = { boot: true, resetHearts: true }
    const result = await updating({
      ...deps,
      rollBack: async () => {
        rolledBack = true
      },
    }).run(ctx)
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('The corrupt hearts path must stop the new season')
    expect(result.detail).toContain(refused.stderr.trim())
    expect(result.detail).toContain('Resetting the hearts failed')
    expect(rolledBack).toBe(true)
    expect(steps).toContain('rolling_back')
  } finally {
    await h.close()
  }
}

async function cancelledBoot() {
  const { h, deps, ctx } = await fixture()
  try {
    const cancelled = new NoLongerApplies()
    await expect(
      updating({
        ...deps,
        boot: {
          run: async () => {
            throw cancelled
          },
        },
      }).run(ctx),
    ).rejects.toBeInstanceOf(NoLongerApplies)
  } finally {
    await h.close()
  }
}

describe.skipIf(!hasDatabase)('updating handler guard boundaries', () => {
  test('requires a runtime handle', missingBinding, 30 * SECOND_MS)
  test('requires a previously applied configuration', missingApplied, 30 * SECOND_MS)
  test('stops compute when policy refuses another boot', refusesBoot, 30 * SECOND_MS)
  test('resets the season files and preserves plugin configuration', resetsHearts, 30 * SECOND_MS)
  test('rolls back when the real filesystem refuses to reset hearts', refusesCorruptHearts, 30 * SECOND_MS)
  test('lets a cancelled boot escape without rolling it back', cancelledBoot, 30 * SECOND_MS)
})
