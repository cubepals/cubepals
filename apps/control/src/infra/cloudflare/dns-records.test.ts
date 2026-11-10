// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The play names' own records through Cloudflare's SDK, against a zone that answers as its API
 * does (`testing/cloudflare-zone.ts`): only this deployment's are seen or changed.
 */
import { describe, expect, test } from 'bun:test'
import Cloudflare from 'cloudflare'
import { CloudflareZone } from '../../testing/cloudflare-zone.ts'
import { CloudflarePlayRecords } from './dns-records.ts'

describe('the play names’ own records in a Cloudflare zone', () => {
  const kept = (zone: CloudflareZone, deploymentId = 'prod') =>
    new CloudflarePlayRecords(
      { apiToken: 'a-cloudflare-token-with-dns-edit', zoneId: 'zone-123', deploymentId },
      { fetch: zone.fetch, maxRetries: 0 },
    )

  test('are made DNS-only with the wildcard’s TTL, changed in place, and removed', async () => {
    const zone = new CloudflareZone('zone-123')
    const records = kept(zone)
    await records.create('maple.play.cubepals.com', '203.0.113.9')
    const [held] = await records.list()
    expect(held).toMatchObject({ name: 'maple.play.cubepals.com', ipv4: '203.0.113.9' })
    expect(zone.records.get(held?.id ?? '')).toMatchObject({ type: 'A', ttl: 300, proxied: false })
    await records.update({ id: held?.id ?? '', name: 'maple.play.cubepals.com', ipv4: '198.51.100.4' })
    expect((await records.list()).map((r) => r.ipv4)).toEqual(['198.51.100.4'])
    await records.remove(held?.id ?? '')
    expect(await records.list()).toEqual([])
    expect(zone.records.size).toBe(0)
  })

  test('are only those this deployment marked, page after page', async () => {
    const zone = new CloudflareZone('zone-123', 2)
    const wildcard = zone.add({ name: '*.play.cubepals.com', content: '203.0.113.1', comment: 'Terraform' })
    const unmarked = zone.add({ name: 'by-hand.play.cubepals.com', content: '203.0.113.2' })
    const production = kept(zone)
    const staging = kept(zone, 'staging')
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      await production.create(`${name}.play.cubepals.com`, '203.0.113.9')
    await staging.create('a.play.staging.cubepals.com', '203.0.113.7')
    expect((await production.list()).map((r) => r.name).sort()).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((name) => `${name}.play.cubepals.com`),
    )
    expect((await staging.list()).map((r) => r.name)).toEqual(['a.play.staging.cubepals.com'])
    expect(zone.records.get(wildcard.id)).toEqual(wildcard)
    expect(zone.records.get(unmarked.id)).toEqual(unmarked)
  })

  test('a record the zone refuses is the API’s own error', async () => {
    const zone = new CloudflareZone('zone-123')
    zone.refusing.add('taken.play.cubepals.com')
    const refusal = await kept(zone)
      .create('taken.play.cubepals.com', '203.0.113.9')
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(Cloudflare.BadRequestError)
  })
})
