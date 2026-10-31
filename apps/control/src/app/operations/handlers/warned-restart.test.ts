// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A restart, and a change that restarts the server, count down in chat for whoever is on before
 * they are dropped; with nobody on, nothing is said and nothing waits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../../testing/harness.ts'
import { loadRevision } from '../../servers/persistence.ts'
import { restartLine } from './restart-warning.ts'

let h: Harness

const running = async (name: string) => {
  const owner = await h.user(name, 'plus')
  const { id } = await h.create(owner, { name })
  await h.until(id, 'running')
  await h.settled(id)
  return { owner, id }
}

const countdown = [`[Cubepals] ${restartLine(10)}`, `[Cubepals] ${restartLine(3)}`]

describe.skipIf(!hasDatabase)('players warned before a restart', () => {
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('the owner’s restart counts down for whoever is on', async () => {
    const { owner, id } = await running('Tansy')
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await h.app.servers.restart(owner, id, randomUUID())
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(h.minecraft.said(id)).toEqual(countdown)
  }, 60_000)

  test('a change that restarts the server counts down too', async () => {
    const { owner, id } = await running('Umber')
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Sam' })
    const { settings } = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    await h.app.revisions.changeSettings(owner, id, { ...settings, viewDistance: 6 }, randomUUID())
    await h.settled(id)
    expect(h.minecraft.said(id)).toEqual(countdown)
  }, 60_000)

  test('nobody on: nothing said, and no wait', async () => {
    const { owner, id } = await running('Violet')
    const started = Date.now()
    await h.app.servers.restart(owner, id, randomUUID())
    await h.settled(id)
    expect(h.minecraft.said(id)).toEqual([])
    expect(Date.now() - started).toBeLessThan(7000)
  }, 60_000)
})
