// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { nextLevelName } from '../../domain/world/world.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from './persistence.ts'

/**
 * Making a server (§15.6): what it is asked to be is decided before anything is written, and a
 * refusal there leaves nothing behind; what is written is the first revision, the first world
 * and one audit row that says where it came from.
 */
describe.skipIf(!hasDatabase)('creating a server', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const madeBy = (ownerId: string) =>
    h.db.select().from(schema.minecraftServers).where(eq(schema.minecraftServers.ownerId, ownerId))

  const created = async (serverId: string) => {
    const rows = await h.db
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'server.created'), eq(schema.auditLog.subjectId, serverId)))
    return rows.map((row) => row.data)
  }

  test('a release or server type Blockly does not offer is refused, with nothing made', async () => {
    const owner = await h.user('Steve', 'plus')
    await expect(h.create(owner, { name: 'Forged', loader: 'forge', gameVersion: '26.3' })).rejects.toThrow(
      'Cubepals does not offer forge on 26.3 yet.',
    )
    expect(await madeBy(owner.userId)).toEqual([])
  })

  test('a location Blockly does not have is refused, before any build is looked up', async () => {
    const owner = await h.user('Alex', 'plus')
    const asked = h.loaderBuilds.asked.length
    await expect(
      h.create(owner, { name: 'Nowhere', loader: 'paper', gameVersion: '26.2', regionKey: 'nowhere' }),
    ).rejects.toThrow('That location is not available.')
    expect(h.loaderBuilds.asked.length).toBe(asked)
    expect(await madeBy(owner.userId)).toEqual([])
  })

  test('it is made in the region it was asked for, and in the first without one', async () => {
    const owner = await h.user('Kai', 'plus')
    expect((await h.create(owner, { name: 'Over There', regionKey: 'far' })).regionKey).toBe('far')
    expect((await h.create(owner, { name: 'Right Here', regionKey: undefined })).regionKey).toBe('local')
  })

  test('the same request twice is one server, and the second decides nothing again', async () => {
    const owner = await h.user('Robin', 'plus')
    const idempotencyKey = randomUUID()
    const first = await h.create(owner, {
      idempotencyKey,
      name: 'Once',
      loader: 'paper',
      gameVersion: '26.2',
    })
    const asked = h.loaderBuilds.asked.length
    const again = await h.create(owner, {
      idempotencyKey,
      name: 'Once',
      loader: 'paper',
      gameVersion: '26.2',
    })
    expect(again.id).toBe(first.id)
    expect(h.loaderBuilds.asked.length).toBe(asked)
    expect(await madeBy(owner.userId)).toHaveLength(1)
    expect(await created(first.id)).toHaveLength(1)
  })

  test('the first revision pins the build of the server type it was made with', async () => {
    const owner = await h.user('Sam', 'plus')
    const server = await h.create(owner, { name: 'Papered', loader: 'paper', gameVersion: '26.2' })
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.number).toBe(1)
    expect(revision.reason).toBe('created')
    expect(revision.basedOnRevisionId).toBeNull()
    expect(revision.gameVersion).toBe('26.2')
    expect(revision.loader).toBe('paper')
    expect(revision.loaderVersion).toBe('60')
    expect(revision.settings.motd).toBe('"Papered", a server created by Cubepals')
  })

  test('the first world takes the seed and hardcore asked for; a template’s world wins over the request', async () => {
    const owner = await h.user('Jo', 'plus')
    const direct = await h.create(owner, { name: 'Seeded', seed: '12345', hardcore: true })
    const [world] = await h.db.select().from(schema.worlds).where(eq(schema.worlds.serverId, direct.id))
    expect(world).toMatchObject({
      levelName: nextLevelName([]),
      name: 'World',
      seed: '12345',
      levelType: 'minecraft:normal',
      hardcore: true,
      generatedOnVersion: '26.3',
    })

    const templated = await h.create(owner, {
      name: 'Brave',
      from: { kind: 'template', key: 'hardcore' },
      seed: '',
      hardcore: false,
    })
    const [brave] = await h.db.select().from(schema.worlds).where(eq(schema.worlds.serverId, templated.id))
    expect(brave?.hardcore).toBe(true)
    // An empty seed is no seed.
    expect(brave?.seed).toBeNull()
  })

  test('the audit row says what it was made with, and from where', async () => {
    const owner = await h.user('Kim', 'plus')
    const direct = await h.create(owner, { name: 'Plain Audit' })
    expect(await created(direct.id)).toEqual([
      { slug: direct.slug, gameVersion: '26.3', loader: 'vanilla', from: 'direct' },
    ])

    const templated = await h.create(owner, {
      name: 'Templated Audit',
      from: { kind: 'template', key: 'hardcore' },
    })
    expect(await created(templated.id)).toEqual([
      {
        slug: templated.slug,
        gameVersion: '26.3',
        loader: 'vanilla',
        from: 'template',
        template: 'hardcore',
      },
    ])
  })
})
