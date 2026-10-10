// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type pg from 'pg'
import { LockBusy, type Locks } from '../../app/ports/locks.ts'

/**
 * Postgres advisory locks. Each hold keeps one pooled connection for the length of the work, so a
 * process that dies mid-work releases its locks along with its session.
 */
export class PgAdvisoryLocks implements Locks {
  readonly #pool: pg.Pool

  constructor(pool: pg.Pool) {
    this.#pool = pool
  }

  async hold<T>(key: string, waitMs: number, work: () => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    let broken: Error | undefined
    try {
      // lock_timeout covers advisory locks as well. SET takes no bind parameters.
      await client.query(`SET lock_timeout = ${Math.max(1, Math.round(waitMs))}`)
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') throw new LockBusy(key)
        throw error
      }
      try {
        return await work()
      } finally {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch((error: Error) => {
            // A session that cannot unlock is closed instead, which releases the lock too.
            broken = error
          })
      }
    } finally {
      if (!broken) await client.query('RESET lock_timeout').catch((error: Error) => (broken = error))
      client.release(broken)
    }
  }
}
