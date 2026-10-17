// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "Run by Cubepals" mark: an admin's alone, audited, and changing only where the directory
 * puts a server, never whether it shows it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

describe.skipIf(!hasDatabase)('the official mark', () => {
  let h: Harness
  const admin: Actor = { kind: 'admin', userId: 'set in beforeAll' }

  beforeAll(async () => {
    h = await startHarness()
    const first = await h.user('Admin')
    await h.db.insert(schema.platformAdmins).values({ userId: first.userId, grantedBy: 'test' })
    Object.assign(admin, { userId: first.userId })
  }, 30_000)

  afterAll(() => h.close())

  const running = async () => {
    const owner = await h.user('Steve')
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id }
  }
  const listed = async (name: string) => {
    const server = await running()
    await h.app.servers.saveIdentity(server.owner, server.id, { name })
    await h.app.listings.setPublic(server.owner, server.id, true)
    return server
  }
  const inDirectory = async (id: string) =>
    (await h.app.listingQueries.browse({ search: '', tag: null, offset: 0 })).listings.some(
      (l) => l.serverId === id,
    )
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string; name: string }) => error.code ?? error.name,
    )

  test('only an admin marks a server Cubepals runs, which comes first while a join gets in', async () => {
    const ours = await listed('Duels')
    const theirs = await listed('Newer Castle')
    const order = async () =>
      (await h.app.listingQueries.browse({ search: '', tag: null, offset: 0 })).listings
        .map((l) => l.serverId)
        .filter((serverId) => serverId === ours.id || serverId === theirs.id)
    // Unmarked, the listing changed last comes first, as for everyone.
    const touched = () => h.app.listings.setPublic(theirs.owner, theirs.id, true)
    expect(await order()).toEqual([theirs.id, ours.id])

    // Its owner can't claim it, and nobody can without saying why.
    expect(await refusal(h.app.listings.markOfficial(ours.owner, ours.id, true, 'ours'))).toBe('NotFound')
    expect(await refusal(h.app.listings.markOfficial(admin, ours.id, true, ' '))).toBe('invalid_choice')
    await h.app.listings.markOfficial(admin, ours.id, true, 'Cubepals runs it')
    await touched()
    expect(await order()).toEqual([ours.id, theirs.id])
    expect(await h.app.listingQueries.detail(ours.id)).toMatchObject({ official: true })
    expect(await h.app.listingQueries.detail(theirs.id)).toMatchObject({ official: false })
    const slug = (await h.server(ours.id)).slug
    expect(await h.app.sharingQueries.page(slug, null)).toMatchObject({ official: true })
    const fleet = await h.app.fleet.list(admin, { search: ours.id, offset: 0, limit: 10 })
    expect(fleet.servers.map((s) => s.official)).toEqual([true])
    const [audited] = await h.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'listing.marked_official'))
    expect(audited).toMatchObject({ subjectId: ours.id, data: { reason: 'Cubepals runs it' } })

    // One no join can wake takes its usual place.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'failed' })
      .where(eq(schema.minecraftServers.id, ours.id))
    expect(await order()).toEqual([theirs.id, ours.id])
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'running' })
      .where(eq(schema.minecraftServers.id, ours.id))

    // Every other rule holds: an admin's removal takes it out like any listing.
    await h.app.listings.moderate(admin, ours.id, 'remove', 'Testing removal.')
    expect(await inDirectory(ours.id)).toBe(false)
    await h.app.listings.moderate(admin, ours.id, 'restore', '')
    await h.app.listings.markOfficial(admin, ours.id, false, 'No longer ours')
    await touched()
    expect(await order()).toEqual([theirs.id, ours.id])
    expect(await h.app.listingQueries.detail(ours.id)).toMatchObject({ official: false })
  }, 40_000)
})
