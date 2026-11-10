// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The play names' own records (`play-records.ts`): which are wanted and what changes the zone, and
 * passes over servers made, renamed, moved, stored, trashed and restored, against a zone that
 * answers as Cloudflare's API does, through the real adapter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { CloudflarePlayRecords } from '../../infra/cloudflare/dns-records.ts'
import { CloudflareZone } from '../../testing/cloudflare-zone.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { PLAY_RECORDS_PER_PASS, recordChanges, wantedRecords } from './play-records.ts'

const FAR = '203.0.113.9'

describe('which play records are wanted', () => {
  const namesOf = (slug: string) => [`${slug}.play.test`, `${slug}.play.old.test`]

  test('every name of a server in a region with an address, at that address, and no other', () => {
    const wanted = wantedRecords(
      [
        { slug: 'maple', regionKey: 'far' },
        { slug: 'cedar', regionKey: 'local' },
      ],
      namesOf,
      { far: FAR },
    )
    expect([...wanted]).toEqual([
      ['maple.play.test', FAR],
      ['maple.play.old.test', FAR],
    ])
  })

  test('held records are kept, moved, removed or made to match', () => {
    const wanted = new Map([
      ['same.play.test', FAR],
      ['moved.play.test', FAR],
      ['new.play.test', FAR],
    ])
    const held = [
      { id: '1', name: 'Same.Play.Test', ipv4: FAR },
      { id: '2', name: 'moved.play.test', ipv4: '198.51.100.4' },
      { id: '3', name: 'gone.play.test', ipv4: FAR },
      { id: '4', name: 'same.play.test', ipv4: FAR },
    ]
    expect(recordChanges(wanted, held)).toEqual({
      create: [{ name: 'new.play.test', ipv4: FAR }],
      update: [{ id: '2', name: 'moved.play.test', ipv4: FAR }],
      // A name held twice keeps one record.
      remove: [held[2], held[3]].filter((record) => record !== undefined),
    })
    expect(recordChanges(new Map(), [])).toEqual({ create: [], update: [], remove: [] })
  })
})

// Servers on the harness's two regions, with `far` given an address of its own.
describe.skipIf(!hasDatabase)('the play records pass', () => {
  let h: Harness
  const zone = new CloudflareZone('zone-123', 50)
  const records = new CloudflarePlayRecords(
    { apiToken: 'a-cloudflare-token-with-dns-edit', zoneId: 'zone-123', deploymentId: 'test' },
    { fetch: zone.fetch, maxRetries: 0 },
  )
  const kept = () =>
    [...zone.records.values()]
      .filter((record) => record.comment?.startsWith('Blockly test:'))
      .map((record) => [record.name, record.content])
      .sort()

  beforeAll(async () => {
    h = await startHarness({
      capabilities: {
        archives: null,
        billing: null,
        playRecords: { records, regionIpv4: { far: FAR } },
      },
    })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  beforeEach(async () => {
    zone.records.clear()
    zone.refusing.clear()
    await h.db.update(schema.minecraftServers).set({ deletedAt: new Date() })
  })

  test('a server far away gets its names there, and loses them in the trash', async () => {
    const wildcard = zone.add({ name: '*.play.test', content: '203.0.113.1', comment: 'Terraform' })
    const owner = await h.user('Alex')
    const near = await h.create(await h.user('Ana'), { name: 'Near' })
    const far = await h.create(owner, { name: 'Far', regionKey: 'far' })
    expect(await h.app.edge.playRecords.keep()).toBe(2)
    expect(kept()).toEqual([
      [`${far.slug}.play.old.test`, FAR],
      [`${far.slug}.play.test`, FAR],
    ])
    expect(await h.app.edge.playRecords.keep()).toBe(0)

    await Promise.all([h.settled(near.id), h.settled(far.id)])
    await h.app.servers.deleteServer(owner, far.id, 'Far')
    expect(await h.app.edge.playRecords.keep()).toBe(2)
    expect(kept()).toEqual([])
    await h.app.servers.undeleteServer(owner, far.id)
    await h.app.edge.playRecords.keep()
    expect(kept()).toHaveLength(2)
    expect(zone.records.get(wildcard.id)).toEqual(wildcard)
    await h.settled(far.id)
  }, 60_000)

  test('a stored server keeps its names: a join wakes it there', async () => {
    const owner = await h.user('Robin')
    const server = await h.create(owner, { name: 'Resting', regionKey: 'far' })
    await h.settled(server.id)
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stored' })
      .where(eq(schema.minecraftServers.id, server.id))
    await h.app.edge.playRecords.keep()
    expect(kept()).toHaveLength(2)
  }, 60_000)

  test('a new address moves its names; a move out of the region removes them', async () => {
    const owner = await h.user('Sam')
    const server = await h.create(owner, { name: 'Moving', regionKey: 'far' })
    await h.settled(server.id)
    await h.app.edge.playRecords.keep()
    await h.app.servers.changeAddress(owner, server.id, 'brand-new-address')
    expect(await h.app.edge.playRecords.keep()).toBe(4)
    expect(kept().map(([name]) => name)).toEqual([
      'brand-new-address.play.old.test',
      'brand-new-address.play.test',
    ])
    // Its compute placed nearby, as a finished move leaves it.
    await h.db
      .update(schema.serverRuntimes)
      .set({ placementRegionKey: 'local' })
      .where(eq(schema.serverRuntimes.serverId, server.id))
    await h.app.edge.playRecords.keep()
    expect(kept()).toEqual([])
  }, 60_000)

  test('a refused record fails the pass, after the others are made, and is tried again', async () => {
    const owner = await h.user('Kim')
    const first = await h.create(await h.user('Jo'), { name: 'First', regionKey: 'far' })
    const second = await h.create(owner, { name: 'Second', regionKey: 'far' })
    zone.refusing.add(`${first.slug}.play.test`)
    await expect(h.app.edge.playRecords.keep()).rejects.toThrow(
      'The zone refused 1 of 4 changes to play records',
    )
    expect(kept().map(([name]) => name)).toContain(`${second.slug}.play.test`)
    zone.refusing.clear()
    expect(await h.app.edge.playRecords.keep()).toBe(1)
    expect(kept()).toHaveLength(4)
    await Promise.all([h.settled(first.id), h.settled(second.id)])
  }, 60_000)

  test('a pass changes at most its share of records; the next changes the rest', async () => {
    // Names no server has any more, as when a region's address is taken away.
    for (let i = 0; i <= PLAY_RECORDS_PER_PASS; i++) await records.create(`gone-${i}.play.test`, FAR)
    expect(await h.app.edge.playRecords.keep()).toBe(PLAY_RECORDS_PER_PASS)
    expect(await h.app.edge.playRecords.keep()).toBe(1)
    expect(kept()).toEqual([])
  })
})
