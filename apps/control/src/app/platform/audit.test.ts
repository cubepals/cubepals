// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// The audit log's pages on Postgres, which keeps `at` to the microsecond while a `Date` holds
// milliseconds: a page's cursor still lands between entries written within one millisecond.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

describe.skipIf(!hasDatabase)('audit log pages', () => {
  let h: Harness
  let admin: Extract<Actor, { kind: 'admin' }>

  beforeAll(async () => {
    h = await startHarness()
    const person = await h.user('Admin')
    await h.db.insert(schema.platformAdmins).values({ userId: person.userId, grantedBy: 'test' })
    admin = { kind: 'admin', userId: person.userId }
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('pages through entries written within one millisecond', async () => {
    const subject = randomUUID()
    await h.db.execute(sql`
      insert into audit_log (actor, action, subject_type, subject_id, data, at)
      select 'system:test', 'test.same_millisecond', 'server', ${subject},
             jsonb_build_object('n', n), '2026-01-01T00:00:00Z'::timestamptz + n * interval '1 microsecond'
      from generate_series(0, 51) as n`)
    const query = { action: 'test.same_millisecond', who: '', subject }
    const first = await h.app.audit.search(admin, { ...query, cursor: null })
    const second = await h.app.audit.search(admin, { ...query, cursor: first.next })
    expect([...first.entries, ...second.entries].map((e) => e.data.n)).toEqual(
      Array.from({ length: 52 }, (_, i) => 51 - i),
    )
    expect(second.next).toBeNull()
  })
})
