// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real console saves preserve access, report failed saves, and precede a restart with its reason. */
import { describe, expect, spyOn, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { kickEveryone, LIST_UUIDS, SAVE_ALL_FLUSH } from '../../../minecraft/console.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { hasDatabase, startHarness } from '../../../testing/harness.ts'
import { RuntimeRouter } from '../../runtimes/router.ts'
import { loadRuntime } from '../../servers/persistence.ts'
import { gameConsole } from './game-console.ts'
import { RESTARTING } from './restart-notice.ts'

async function fixture() {
  const h = await startHarness()
  try {
    const owner = await h.user()
    const created = await h.create(owner)
    const server = await h.until(created.id, 'running')
    await h.settled(server.id)
    const runtime = new RuntimeRouter([...h.runtimes.values()])
    const { handle } = await loadRuntime(h.db, server.id, runtime.providers)
    if (!handle) throw new Error('A running server needs its runtime handle')
    const game = gameConsole({ runtime, specs: h.app.specs, console: h.minecraft, access: h.app.reconciler })
    return { h, server, runtime, handle, game }
  } catch (error) {
    await h.close()
    throw error
  }
}

async function consoleAddress() {
  const { h, server, runtime, handle, game } = await fixture()
  const endpoint = spyOn(runtime, 'endpoint')
  try {
    const target = game.consoleTarget(server, handle)
    expect(endpoint).toHaveBeenCalledWith(handle, PORT_NAMES.rcon, 'control')
    expect(target.passwords).toEqual(h.app.specs.rconPasswords(server.id))
    await h.minecraft.run(target, SAVE_ALL_FLUSH)
    expect(h.minecraft.heard(server.id).at(-1)).toBe(SAVE_ALL_FLUSH)
  } finally {
    endpoint.mockRestore()
    await h.close()
  }
}

async function savesWithoutNotice() {
  const { h, server, runtime, handle, game } = await fixture()
  const reconcile = spyOn(h.app.reconciler, 'reconcile')
  const endpoint = spyOn(runtime, 'endpoint')
  const sent = spyOn(h.minecraft, 'runAll')
  try {
    expect(await game.windDown(server, handle)).toBe(true)
    expect(reconcile).toHaveBeenCalledWith(server, handle, 'import')
    expect(endpoint).toHaveBeenCalledWith(handle, PORT_NAMES.rcon, 'control')
    expect(h.minecraft.heard(server.id).at(-1)).toBe(SAVE_ALL_FLUSH)
    expect(sent).not.toHaveBeenCalled()
  } finally {
    reconcile.mockRestore()
    endpoint.mockRestore()
    sent.mockRestore()
    await h.close()
  }
}

async function savesDespiteAccessFailure() {
  const { h, server, runtime, handle, game } = await fixture()
  await runtime.stop(handle)
  const unavailable = await h.minecraft.run(game.consoleTarget(server, handle), SAVE_ALL_FLUSH).then(
    () => {
      throw new Error('A stopped server must refuse console commands')
    },
    (error: unknown) => error,
  )
  await runtime.start(handle)
  const reconcile = spyOn(h.app.reconciler, 'reconcile').mockRejectedValue(unavailable)
  try {
    expect(await game.windDown(server, handle)).toBe(true)
    expect(reconcile).toHaveBeenCalledWith(server, handle, 'import')
    expect(h.minecraft.heard(server.id).at(-1)).toBe(SAVE_ALL_FLUSH)
  } finally {
    reconcile.mockRestore()
    await h.close()
  }
}

async function reportsFailedSave() {
  const { h, server, handle, game } = await fixture()
  try {
    h.minecraft.refuseCommands(new RegExp(`^${SAVE_ALL_FLUSH}$`))
    expect(await game.windDown(server, handle)).toBe(false)
  } finally {
    h.minecraft.refuseCommands(null)
    await h.close()
  }
}

async function givesRestartReason() {
  const { h, server, handle, game } = await fixture()
  try {
    const start = h.minecraft.heard(server.id).length
    expect(await game.windDown(server, handle, RESTARTING)).toBe(true)
    const heard = h.minecraft.heard(server.id).slice(start)
    expect(heard[0]).toBe(LIST_UUIDS)
    const kicked = kickEveryone(RESTARTING)
    expect(heard).toEqual(expect.arrayContaining([...kicked, SAVE_ALL_FLUSH]))
    expect(heard.indexOf(SAVE_ALL_FLUSH)).toBeGreaterThan(heard.indexOf(kicked[0] ?? ''))
  } finally {
    await h.close()
  }
}

describe.skipIf(!hasDatabase)('operation game console', () => {
  test('targets the control RCON endpoint with the server passwords', consoleAddress, 30 * SECOND_MS)
  test(
    'imports access and saves without announcing an unspecified restart',
    savesWithoutNotice,
    30 * SECOND_MS,
  )
  test('still saves when access reconciliation fails', savesDespiteAccessFailure, 30 * SECOND_MS)
  test('reports a refused flush as an unsuccessful save', reportsFailedSave, 30 * SECOND_MS)
  test('lists players and sends the restart reason before saving', givesRestartReason, 30 * SECOND_MS)
})
