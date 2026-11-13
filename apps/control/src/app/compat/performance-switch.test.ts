// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's switch for the performance mods Cubepals adds, and what the settings page shows of
 * them: saved and audited, the owner's alone, only on a server they are for, and never a restart.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { asc, eq } from 'drizzle-orm'
import { FERRITECORE, KRYPTON, LITHIUM } from '../../minecraft/mods.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { loadRevision } from '../servers/persistence.ts'
import { performanceFor, performanceOff, setPerformance } from './performance.ts'
import { performanceModsView } from './performance-view.ts'

let h: Harness
const cdn = new Cdn()

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness()
}, 30_000)

afterAll(async () => {
  try {
    await h?.close()
  } finally {
    cdn.close()
  }
})

const ALL = ['Lithium', 'FerriteCore', 'Krypton']

/** One of the mods as the pins job keeps it for a release, under its real project id. */
const pin = async (gameVersion: string, projectId: string, name: string) => {
  const mod = cdn.publish(name)
  await h.db.insert(schema.compatPlugins).values({
    gameVersion,
    projectId,
    pinned: { ...mod, source: { ...mod.source, projectId } },
    pinnedAt: new Date(),
  })
}

/** A running Fabric server with no mods of its owner's, on a release with all three pinned. */
const fabric = async (name: string) => {
  const owner = await h.user(name, 'plus')
  const { id } = await h.create(owner, { loader: 'fabric' })
  await h.until(id, 'running')
  await h.settled(id)
  const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
  const pinned = await h.db
    .select({ projectId: schema.compatPlugins.projectId })
    .from(schema.compatPlugins)
    .where(eq(schema.compatPlugins.gameVersion, revision.gameVersion))
  for (const [projectId, mod] of [
    [LITHIUM, 'Lithium'],
    [FERRITECORE, 'FerriteCore'],
    [KRYPTON, 'Krypton'],
  ] as const)
    if (!pinned.some((row) => row.projectId === projectId)) await pin(revision.gameVersion, projectId, mod)
  return { owner, id, revision }
}

/** The switch as the server's own view carries it to the settings page. */
const shown = async (owner: Awaited<ReturnType<typeof fabric>>['owner'], id: string) =>
  (await h.app.queries.get(owner, id)).performanceMods

/** What was recorded of the switch for a server, oldest first. */
const audited = async (id: string) =>
  (
    await h.db
      .select({ actor: schema.auditLog.actor, action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, id))
      .orderBy(asc(schema.auditLog.at))
  ).filter((row) => row.action.startsWith('server.performance_mods_'))

/** Everything a restart or a new revision would move. */
const standing = async (id: string) => {
  const server = await h.server(id)
  const revisions = await h.db
    .select({ id: schema.serverRevisions.id })
    .from(schema.serverRevisions)
    .where(eq(schema.serverRevisions.serverId, id))
  return {
    status: server.lifecycle.status,
    desiredRevisionId: server.desiredRevisionId,
    revisions: revisions.length,
    operations: (await h.operations(id)).map((op) => `${op.kind}:${op.status}`),
  }
}

describe.skipIf(!hasDatabase)('the owner’s switch for the performance mods', () => {
  test('its owner turns them off and on, and the server’s view says so', async () => {
    const { owner, id } = await fabric('Alder')
    expect(await shown(owner, id)).toEqual({ on: true, turnedOff: null, mods: ALL })
    const { version } = await h.server(id)

    await h.app.servers.performanceMods.set(owner, id, false)
    expect(await performanceOff(h.db, id)).toBe('owner')
    // Off, it still names the ones the switch would bring back.
    expect(await shown(owner, id)).toEqual({ on: false, turnedOff: 'owner', mods: ALL })
    expect((await h.server(id)).version).toBe(version + 1)

    await h.app.servers.performanceMods.set(owner, id, true)
    expect(await performanceOff(h.db, id)).toBeNull()
    expect(await shown(owner, id)).toEqual({ on: true, turnedOff: null, mods: ALL })
    expect(await audited(id)).toEqual(
      ['server.performance_mods_off', 'server.performance_mods_on'].map((action) => ({
        actor: requestedBy(owner),
        action,
      })),
    )
  }, 60_000)

  test('a press that leaves the choice as it was changes and records nothing', async () => {
    const { owner, id } = await fabric('Beech')
    const { version } = await h.server(id)
    await h.app.servers.performanceMods.set(owner, id, true)
    expect(await audited(id)).toEqual([])
    await h.app.servers.performanceMods.set(owner, id, false)
    await h.app.servers.performanceMods.set(owner, id, false)
    expect(await audited(id)).toHaveLength(1)
    expect((await h.server(id)).version).toBe(version + 1)
  }, 60_000)

  test('nothing restarts for it, and it makes no revision', async () => {
    const { owner, id } = await fabric('Clover')
    const before = await standing(id)
    expect(before.status).toBe('running')
    await h.app.servers.performanceMods.set(owner, id, false)
    await h.app.servers.performanceMods.set(owner, id, true)
    await h.settled(id)
    expect(await standing(id)).toEqual(before)
  }, 60_000)

  test('turning them on is the way back from a start that turned them off', async () => {
    const { owner, id } = await fabric('Dogwood')
    await setPerformance(h.db, id, false, 'clash')
    expect(await shown(owner, id)).toEqual({ on: false, turnedOff: 'clash', mods: ALL })
    // The owner's own off takes the place of Cubepals'.
    await h.app.servers.performanceMods.set(owner, id, false)
    expect((await shown(owner, id))?.turnedOff).toBe('owner')
    await setPerformance(h.db, id, false, 'clash')
    await h.app.servers.performanceMods.set(owner, id, true)
    expect(await shown(owner, id)).toEqual({ on: true, turnedOff: null, mods: ALL })
  }, 60_000)

  test('it names what a start places: not one its owner runs, and none not pinned yet', async () => {
    const { id, revision } = await fabric('Elder')
    const [lithium] = await performanceFor(h.db, id, revision)
    if (lithium === undefined) throw new Error('Lithium was not pinned')
    const { dir: _dir, ...theirs } = lithium
    const withTheirs = { ...revision, mods: [theirs] }
    const rest = ['FerriteCore', 'Krypton']
    expect(await performanceModsView(h.db, id, withTheirs)).toEqual({ on: true, turnedOff: null, mods: rest })
    const unpinned = { ...revision, gameVersion: '0.0.1' }
    expect(await performanceModsView(h.db, id, unpinned)).toEqual({ on: true, turnedOff: null, mods: [] })
    await setPerformance(h.db, id, false)
    expect((await performanceModsView(h.db, id, withTheirs))?.mods).toEqual(rest)
    expect((await performanceModsView(h.db, id, unpinned))?.mods).toEqual([])
    // A server playing a pack is tested as it is: there is nothing to show.
    expect(await performanceModsView(h.db, id, { ...revision, modpack: {} as never })).toBeNull()
  }, 60_000)

  test('nobody else changes it, and whoever runs the platform can', async () => {
    const { id } = await fabric('Fern')
    const stranger = await h.user('Stranger', 'plus')
    await expect(h.app.servers.performanceMods.set(stranger, id, false)).rejects.toBeInstanceOf(NotFound)
    expect(await performanceOff(h.db, id)).toBeNull()
    expect(await audited(id)).toEqual([])
    const admin = { kind: 'admin', userId: stranger.userId } as const
    await h.app.servers.performanceMods.set(admin, id, false)
    expect(await performanceOff(h.db, id)).toBe('owner')
    expect(await audited(id)).toEqual([{ actor: requestedBy(admin), action: 'server.performance_mods_off' }])
  }, 60_000)

  test('a server they are not for shows nothing and refuses the switch', async () => {
    const owner = await h.user('Gale')
    const paper = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
    const plain = await h.create(await h.user('Hazel'), {})
    for (const { id, ownerId } of [paper, plain]) {
      await h.until(id, 'running')
      await h.settled(id)
      const actor = { kind: 'user', userId: ownerId } as const
      expect(await shown(actor, id)).toBeNull()
      for (const on of [true, false]) {
        const refused = h.app.servers.performanceMods.set(actor, id, on)
        await expect(refused).rejects.toBeInstanceOf(AppError)
        await expect(refused).rejects.toMatchObject({
          code: 'invalid_choice',
          message: 'Cubepals adds performance mods only to Fabric servers without a modpack.',
        })
      }
      expect(await performanceOff(h.db, id)).toBeNull()
      expect(await audited(id)).toEqual([])
    }
  }, 60_000)
})
