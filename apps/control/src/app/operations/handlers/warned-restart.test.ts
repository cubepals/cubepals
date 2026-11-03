// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A restart, and a change that restarts the server, count down in chat for whoever is on before
 * they are dropped, and only a change says it is one; with nobody on, nothing is said and nothing
 * waits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../../testing/harness.ts'
import type { Actor } from '../../actor.ts'
import { loadRevision } from '../../servers/persistence.ts'

let h: Harness

const running = async (name: string) => {
  const owner = await h.user(name, 'plus')
  const { id } = await h.create(owner, { name })
  await h.until(id, 'running')
  await h.settled(id)
  return { owner, id }
}

/** A restart asked for says when, and claims no change; a change that restarts says it is one. */
const lastLine = '[Cubepals] Restarting in 3 seconds. See you in a minute.'
const restarting = [
  '[Cubepals] The server restarts in 10 seconds. You can join again in about a minute.',
  lastLine,
]
const changing = [
  '[Cubepals] The server restarts in 10 seconds for a change its owner made. You can join again in about a minute.',
  lastLine,
]

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
    expect(h.minecraft.said(id)).toEqual(restarting)
    // The countdown first, then everyone is turned out with why (`restart-notice.ts`).
    const heard = h.minecraft.heard(id)
    const counted = heard.findIndex((command) => command.startsWith('tellraw'))
    const kicked = heard.findIndex((command) => /^(minecraft:)?kick @a/.test(command))
    expect(counted).toBeGreaterThanOrEqual(0)
    expect(kicked).toBeGreaterThan(counted)
  }, 60_000)

  test('a change that restarts the server counts down too', async () => {
    const { owner, id } = await running('Umber')
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Sam' })
    const { settings } = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    await h.app.revisions.changeSettings(owner, id, { ...settings, viewDistance: 6 }, randomUUID())
    await h.settled(id)
    expect(h.minecraft.said(id)).toEqual(changing)
  }, 60_000)

  test('an admin’s restart claims no change either', async () => {
    const { id } = await running('Wren')
    const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Kai' })
    await h.app.servers.restart(admin, id, randomUUID())
    await h.settled(id)
    expect(h.minecraft.said(id)).toEqual(restarting)
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
