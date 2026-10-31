// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stop cheaters' switch while players are on: it waits for everyone to leave where the owner chose
 * to, shows as waiting, and is taken now or dropped; a press that ends where the server already runs
 * restarts nothing; a boot from before boots said what they placed is read by its mark.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { GRIM } from '../../minecraft/stop-cheaters.ts'
import { compareVersions, offeredVersions, supports } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { loadApplied } from '../servers/restart-wait.ts'
import { loadStopCheaters } from './persistence.ts'
import { stopCheatersWaiting } from './waiting.ts'

let h: Harness
const cdn = new Cdn()

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness()
  h.catalog.publish(
    {
      projectId: GRIM,
      slug: 'grimac',
      name: 'Grim Anticheat',
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    [
      {
        versionId: 'grim-1',
        projectId: GRIM,
        versionLabel: '2.3',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['paper', 'spigot'],
        gameVersions: offeredVersions().map((offered) => offered.id),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file: cdn.file('grim-1'),
        dependencies: [],
      },
    ],
  )
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

/** A running Paper server with Stop cheaters off, and someone playing on it. */
const occupied = async (name: string) => {
  const owner = await h.user(name, 'free')
  const { id } = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
  await h.until(id, 'running')
  await h.settled(id)
  h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
  await h.app.schedules.presenceSync()
  return { owner, id }
}

const applies = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply')
const waitingOf = async (id: string) =>
  stopCheatersWaiting(h.db, await h.server(id), await loadApplied(h.db, id))

describe.skipIf(!hasDatabase)('Stop cheaters while players are on', () => {
  test('waits for everyone to leave, and turned back, restarts nothing', async () => {
    const { owner, id } = await occupied('Nell')
    expect(await waitingOf(id)).toBeNull()
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'empty')
    expect(await applies(id)).toHaveLength(0)
    expect(await waitingOf(id)).toBe('on')
    expect((await h.app.queries.get(owner, id)).waiting).toEqual({
      changes: [],
      size: null,
      stopCheaters: 'on',
    })
    // Changed back before anyone left: what runs is what was asked, so nothing restarts.
    await h.app.stopCheaters.set(owner, id, false, randomUUID(), 'now')
    expect(await applies(id)).toHaveLength(0)
    expect(await waitingOf(id)).toBeNull()
    expect((await h.app.queries.get(owner, id)).waiting).toBeNull()
  }, 60_000)

  test('restarts now when the owner says so, booting for it', async () => {
    const { owner, id } = await occupied('Opal')
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'now')
    const [apply] = await applies(id)
    expect(apply?.input).toEqual({ boot: true })
    await h.settled(id)
    expect((await loadApplied(h.db, id))?.placedStopCheaters).toBe(true)
    expect(await waitingOf(id)).toBeNull()
  }, 60_000)

  test('taken now from the page, the server boots for it; dropped, the switch goes back', async () => {
    const { owner, id } = await occupied('Pearl')
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'empty')
    await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
    expect((await loadStopCheaters(h.db, id)).setting).toBe('off')
    expect(await waitingOf(id)).toBeNull()
    expect(await applies(id)).toHaveLength(0)

    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'empty')
    await h.app.stopCheaters.waiting.settle(owner, id, 'now', randomUUID())
    const [apply] = await applies(id)
    expect(apply?.input).toMatchObject({ boot: true })
    await h.settled(id)
    expect(await waitingOf(id)).toBeNull()

    // Running with it on: off, waiting, dropped, puts it back on.
    await h.app.stopCheaters.set(owner, id, false, randomUUID(), 'empty')
    expect(await waitingOf(id)).toBe('off')
    await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
    expect((await loadStopCheaters(h.db, id)).setting).toBe('on')
  }, 90_000)

  test('Cubepals’ settings in place of the owner’s wait too, and dropping them keeps the owner’s', async () => {
    const { owner, id } = await occupied('Quill')
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'now')
    await h.settled(id)
    await h.app.stopCheaters.useOurs(owner, id, randomUUID(), 'empty')
    expect(await waitingOf(id)).toBe('ours')
    expect(await applies(id)).toHaveLength(1)
    await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
    expect((await loadStopCheaters(h.db, id)).takeOver).toBe(false)
    expect(await waitingOf(id)).toBeNull()
  }, 90_000)

  test('a boot from before boots said what they placed is read by its mark', async () => {
    const { owner, id } = await occupied('Rue')
    const forget = (mark: 'ours' | null) =>
      h.db
        .update(schema.serverRuntimes)
        .set({
          applied:
            mark === null
              ? sql`${schema.serverRuntimes.applied} - 'placedStopCheaters' - 'stopCheaters'`
              : sql`(${schema.serverRuntimes.applied} - 'placedStopCheaters') || '{"stopCheaters":"ours"}'::jsonb`,
        })
        .where(eq(schema.serverRuntimes.serverId, id))
    await forget(null)
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'empty')
    expect(await waitingOf(id)).toBe('on')
    await forget('ours')
    expect(await waitingOf(id)).toBeNull()
  }, 60_000)

  test('a stopped server has nothing waiting: its next start takes the switch', async () => {
    const { owner, id } = await occupied('Sage')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'now')
    expect(await waitingOf(id)).toBeNull()
    expect(await applies(id)).toHaveLength(0)
  }, 60_000)
  test('dropping a waiting version that only made Grim available leaves the owner’s switch alone', async () => {
    const papers = offeredVersions()
      .filter((offered) => supports(offered.id, 'paper'))
      .sort((a, b) => compareVersions(b.id, a.id))
    const [newer, older] = papers
    if (newer === undefined || older === undefined) throw new Error('Two Paper releases are needed')
    const owner = await h.user('Teal', 'free')
    const { id } = await h.create(owner, { loader: 'paper', gameVersion: older.id })
    await h.until(id, 'running')
    await h.settled(id)
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    const ran = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    // Its release has no Grim yet: the owner's "on" places nothing, and restarts nothing.
    await h.db
      .delete(schema.compatPlugins)
      .where(
        and(eq(schema.compatPlugins.projectId, GRIM), eq(schema.compatPlugins.gameVersion, ran.gameVersion)),
      )
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'now')
    expect(await applies(id)).toHaveLength(0)
    // A newer release, which has Grim, waits for everyone to leave.
    await h.app.mods.changeVersion(owner, id, { gameVersion: newer.id, loader: 'paper' }, [], randomUUID(), {
      when: 'empty',
    })
    expect(await waitingOf(id)).toBe('on')
    await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
    // The version goes back; the switch stays as the owner set it.
    expect((await h.server(id)).desiredRevisionId).toBe(ran.id)
    expect((await loadStopCheaters(h.db, id)).setting).toBe('on')
    expect(await waitingOf(id)).toBeNull()
    await h.app.setups.compat.refresh()
  }, 90_000)
})
