// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The economics report where the deployment has no figures for fees and backups: it still reports
 * what ran and what was paid, and leaves fees and margin out rather than failing or guessing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { DEFAULT_ECONOMICS_TUNING } from '../../domain/account/tuning.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { installTuning, tuning } from '../tuning.ts'

let h: Harness
const installed = tuning()
const withEconomics = (economics: typeof installed.economics) => installTuning({ ...installed, economics })

describe.skipIf(!hasDatabase)('the economics report without figures for fees', () => {
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(() => h.close())
  afterEach(() => installTuning(installed))

  test('leaves fees and margin out, and keeps what was paid', async () => {
    const owner = await h.user('Payer', 'plus')
    const created = await h.create(owner, { loader: 'vanilla' })
    await h.until(created.id, 'running')
    const now = new Date()
    await h.db.insert(schema.billingOrders).values({
      provider: 'polar',
      externalOrderId: randomUUID(),
      userId: owner.userId,
      planKey: 'plus',
      billingReason: 'subscription_cycle',
      currency: 'usd',
      subtotalCents: 1500,
      discountCents: 0,
      netCents: 1500,
      taxCents: 0,
      totalCents: 1500,
      orderedAt: now,
    })
    const window = { from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + DAY_MS) }

    withEconomics(DEFAULT_ECONOMICS_TUNING)
    const priced = await h.app.economics.report(window)
    expect(priced.runtimes.every((row) => row.feeCents !== null && row.marginCents !== null)).toBe(true)
    expect(priced.servers[0]?.feeCents).toBeGreaterThan(0)

    withEconomics(null)
    const bare = await h.app.economics.report(window)
    expect(bare.runtimes.length).toBeGreaterThan(0)
    for (const row of bare.runtimes)
      expect([row.feeCents, row.marginCents, row.marginPercent]).toEqual([null, null, null])
    for (const server of bare.servers) expect([server.feeCents, server.marginCents]).toEqual([null, null])
    const withoutFees = ({ feeCents: _fee, marginCents: _margin, ...rest }: (typeof bare.servers)[number]) =>
      rest
    expect(bare.servers.map(withoutFees)).toEqual(priced.servers.map(withoutFees))
    expect(bare.assumptions.paymentFee).toMatch(/not configured/)
  }, 60_000)
})
