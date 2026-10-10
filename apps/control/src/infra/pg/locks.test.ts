// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, describe, expect, test } from 'bun:test'
import { createPool } from '@blockly/db'
import { LockBusy } from '../../app/ports/locks.ts'
import { PgAdvisoryLocks } from './locks.ts'

// Needs a real Postgres: DATABASE_URL=postgres://… bun test
const url = process.env.DATABASE_URL
const pool = url ? createPool(url) : null
afterAll(() => pool?.end())

describe.skipIf(!pool)('PgAdvisoryLocks', () => {
  const locks = () => new PgAdvisoryLocks(pool as NonNullable<typeof pool>)
  const key = () => `test:${crypto.randomUUID()}`

  test('holders of one key take turns, other keys do not wait', async () => {
    const k = key()
    const order: string[] = []
    const slow = (name: string) => async () => {
      order.push(`${name} in`)
      await Bun.sleep(50)
      order.push(`${name} out`)
    }
    await Promise.all([
      locks().hold(k, 2000, slow('a')),
      locks().hold(k, 2000, slow('b')),
      locks().hold(key(), 2000, slow('c')),
    ])
    const a = order.indexOf('a in')
    const b = order.indexOf('b in')
    const [first, second] = a < b ? ['a', 'b'] : ['b', 'a']
    expect(order.indexOf(`${second} in`)).toBeGreaterThan(order.indexOf(`${first} out`))
    expect(order.indexOf('c in')).toBeLessThan(order.indexOf(`${first} out`))
  })

  test('a holder that waits too long gets LockBusy', async () => {
    const k = key()
    const held = locks().hold(k, 1000, () => Bun.sleep(400))
    await Bun.sleep(20)
    await expect(locks().hold(k, 100, async () => 'never')).rejects.toBeInstanceOf(LockBusy)
    await held
  })

  test('a failed holder releases the key', async () => {
    const k = key()
    await expect(locks().hold(k, 1000, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await locks().hold(k, 100, async () => 'free')).toBe('free')
  })
})
