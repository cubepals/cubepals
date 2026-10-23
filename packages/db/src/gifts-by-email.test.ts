// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Migration 0097 (gifts by email) both ways, on a database of its own: undone by hand
 * (`rollbacks/0097_gifts_by_email.sql`) and made again, gifts bought before it keep what happened
 * to them as their state, a guest's gift goes by email and an order with no account is a gift's.
 * Undoing it refuses while a guest's paid gift is kept, and drops gifts never paid for.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createDb, createPool, migrationsFolder } from './index.ts'

const base = process.env.DATABASE_URL
const UP = readFileSync(join(migrationsFolder, '0097_gifts_by_email.sql'), 'utf8')
const DOWN = readFileSync(new URL('../rollbacks/0097_gifts_by_email.sql', import.meta.url), 'utf8')

describe.skipIf(!base)('migration 0097, gifts by email', () => {
  const name = `blockly_test_${randomBytes(5).toString('hex')}`
  let client: pg.Client

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const url = new URL(base as string)
    url.pathname = `/${name}`
    const pool = createPool(url.toString())
    await migrate(createDb(pool), { migrationsFolder })
    await pool.end()
    client = new pg.Client({ connectionString: url.toString() })
    await client.connect()
  }, 60_000)

  afterAll(async () => {
    await client?.end()
    const admin = new pg.Client({ connectionString: base })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end()
  })

  const up = () => client.query(UP.replaceAll('--> statement-breakpoint', ''))
  const down = () => client.query(DOWN)
  const columns = async (table: string) =>
    new Map(
      (
        await client.query<{ column_name: string; is_nullable: string }>(
          'SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = $1',
          [table],
        )
      ).rows.map((row) => [row.column_name, row.is_nullable === 'YES']),
    )
  const user = async () => {
    const id = randomUUID()
    await client.query('INSERT INTO users (id, name, email) VALUES ($1, $2, $3)', [
      id,
      'Pia',
      `${id}@example.test`,
    ])
    return id
  }
  const order = (id: string, userId: string | null, giftId: string | null) =>
    client.query(
      `INSERT INTO billing_orders (provider, external_order_id, user_id, gift_id, billing_reason, currency,
        subtotal_cents, discount_cents, net_cents, tax_cents, total_cents, ordered_at)
       VALUES ('polar', $1, $2, $3, 'purchase', 'usd', 1500, 0, 1500, 0, 1500, now())`,
      [id, userId, giftId],
    )

  test('undone and made again, gifts bought before it keep what happened to them', async () => {
    const buyer = await user()
    const friend = await user()
    const gift = (order: string, extra = '') =>
      client.query(
        `INSERT INTO plan_gifts (provider, external_order_id, buyer_id, plan_key, months${extra ? ', redeemed_by, voided_at' : ''})
         VALUES ('polar', $1, $2, 'plus', 1${extra})`,
        [order, buyer],
      )
    await down()
    expect((await columns('plan_gifts')).has('state')).toBe(false)
    expect((await columns('plan_gifts')).get('buyer_id')).toBe(false)
    expect((await columns('plan_gifts')).get('external_order_id')).toBe(false)
    expect((await columns('billing_orders')).get('user_id')).toBe(false)
    expect((await columns('billing_orders')).has('gift_id')).toBe(false)

    await gift('order-waiting')
    await gift('order-redeemed', `, '${friend}', null`)
    await gift('order-refunded', `, '${friend}', now()`)
    await up()
    const states = await client.query<{ external_order_id: string; state: string; delivery: string }>(
      'SELECT external_order_id, state, delivery FROM plan_gifts ORDER BY external_order_id',
    )
    expect(states.rows).toEqual([
      { external_order_id: 'order-redeemed', state: 'claimed', delivery: 'code' },
      { external_order_id: 'order-refunded', state: 'refunded', delivery: 'code' },
      { external_order_id: 'order-waiting', state: 'paid', delivery: 'code' },
    ])
    expect((await columns('plan_gifts')).get('buyer_id')).toBe(true)
    expect((await columns('billing_orders')).get('user_id')).toBe(true)
  })

  test('a guest’s gift goes by email, has an order once paid, and only a gift’s order has no account', async () => {
    const guest = (delivery: string, recipientKey: string | null) =>
      client.query<{ id: string }>(
        `INSERT INTO plan_gifts (provider, buyer_email, delivery, recipient_key, state, plan_key, months)
         VALUES ('polar', 'guest@example.test', $1, $2, 'checkout', 'plus', 1) RETURNING id`,
        [delivery, recipientKey],
      )
    await expect(guest('code', null)).rejects.toThrow(/plan_gifts_guest_by_email/)
    await expect(guest('email', null)).rejects.toThrow(/plan_gifts_emailed_has_recipient/)
    const made = (await guest('email', 'recipient-hash')).rows[0]?.id as string
    await expect(client.query(`UPDATE plan_gifts SET state = 'paid' WHERE id = $1`, [made])).rejects.toThrow(
      /plan_gifts_paid_has_order/,
    )
    await expect(order('order-nobody', null, null)).rejects.toThrow(/billing_orders_payer/)
    await order('order-guest', null, made)
    await client.query(
      `UPDATE plan_gifts SET state = 'paid', external_order_id = 'order-guest' WHERE id = $1`,
      [made],
    )

    // Undone, a guest's paid gift would lose its order: it refuses, and changes nothing.
    await expect(down()).rejects.toThrow(/can't be undone/)
    expect((await columns('plan_gifts')).has('state')).toBe(true)

    // With only a gift never paid for, it goes, and the rest is as before.
    await client.query(`DELETE FROM billing_orders WHERE external_order_id = 'order-guest'`)
    await client.query(`UPDATE plan_gifts SET state = 'checkout', external_order_id = null WHERE id = $1`, [
      made,
    ])
    await down()
    expect((await client.query('SELECT 1 FROM plan_gifts WHERE id = $1', [made])).rowCount).toBe(0)
    expect((await client.query('SELECT 1 FROM plan_gifts')).rowCount).toBe(3)
    await up()
  })
})
