// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What is kept of each host from the boots that read it (`hosts.ts`), against Postgres. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { hostSeen } from './hosts.ts'

const hosts = schema.runtimeHosts
const at = (hours: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + hours * HOUR_MS)
const reading = (id: string, mhz: number | null, model: string | null = 'AMD EPYC') => ({
  model,
  mhz,
  host: { region: 'fra', id },
})

describe.skipIf(!hasDatabase)('the hosts servers booted on', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  const kept = async (provider: string, id: string) =>
    (
      await h.db
        .select()
        .from(hosts)
        .where(and(eq(hosts.provider, provider), eq(hosts.host, id)))
    )[0]

  test('a first reading of a host is kept as its clock, its model and when', async () => {
    await hostSeen(h.db, 'fly', reading('first', 2500), at(1))
    expect(await kept('fly', 'first')).toEqual({
      provider: 'fly',
      region: 'fra',
      host: 'first',
      model: 'AMD EPYC',
      mhz: 2500,
      mhzMin: 2500,
      mhzMax: 2500,
      readings: 1,
      firstSeenAt: at(1),
      lastSeenAt: at(1),
    })
  })

  test('later readings keep the last clock, the least and the most, how many, and when', async () => {
    await hostSeen(h.db, 'fly', reading('again', 2500), at(1))
    await hostSeen(h.db, 'fly', reading('again', 3000), at(2))
    await hostSeen(h.db, 'fly', reading('again', 2000, null), at(3))
    expect(await kept('fly', 'again')).toMatchObject({
      // The last machine named no model: the one before it stays.
      model: 'AMD EPYC',
      mhz: 2000,
      mhzMin: 2000,
      mhzMax: 3000,
      readings: 3,
      firstSeenAt: at(1),
      lastSeenAt: at(3),
    })
  })

  test('a host is one provider’s, in one region: the same name elsewhere is another', async () => {
    await hostSeen(h.db, 'fly', reading('shared', 2000), at(1))
    await hostSeen(h.db, 'other', reading('shared', 3000), at(1))
    await hostSeen(h.db, 'fly', { model: null, mhz: 2500, host: { region: 'iad', id: 'shared' } }, at(1))
    const rows = await h.db.select().from(hosts).where(eq(hosts.host, 'shared'))
    expect(rows.map((row) => [row.provider, row.region, row.mhz, row.readings]).sort()).toEqual([
      ['fly', 'fra', 2000, 1],
      ['fly', 'iad', 2500, 1],
      ['other', 'fra', 3000, 1],
    ])
  })

  test('a reading that names no host, or no clock, is not kept', async () => {
    await hostSeen(h.db, 'fly', { model: 'AMD EPYC', mhz: 3000, host: null }, at(1))
    await hostSeen(h.db, 'fly', reading('silent', null), at(1))
    expect(await kept('fly', 'silent')).toBeUndefined()
  })
})
