// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Account UUID ordering never decides which signup a free-play link records as the later one. */
import { describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { addCandidate, type Candidates, scorePairs } from './free-links.ts'

describe.skipIf(!hasDatabase)('free account link signup order', () => {
  test(
    'uses creation time in both UUID orders',
    async () => {
      const h = await startHarness()
      try {
        const accounts = [await h.user(), await h.user()].sort((a, b) => a.userId.localeCompare(b.userId))
        const [low, high] = accounts
        if (!low || !high) throw new Error('The pair needs two real accounts')
        const anchor = Date.now() - SECOND_MS
        for (const later of [low, high]) {
          const earlier = later === low ? high : low
          await h.db
            .update(schema.users)
            .set({ createdAt: new Date(anchor + 1) })
            .where(eq(schema.users.id, later.userId))
          await h.db
            .update(schema.users)
            .set({ createdAt: new Date(anchor) })
            .where(eq(schema.users.id, earlier.userId))
          await h.db.delete(schema.freeLinks)
          const found: Candidates = new Map()
          addCandidate(found, low.userId, high.userId, { mainPlayer: 1 })
          await scorePairs(h.db, found)
          const links = await h.db.select().from(schema.freeLinks)
          expect(links.map((link) => [link.accountId, link.linkedId])).toEqual([
            [later.userId, earlier.userId],
          ])
        }
      } finally {
        await h.close()
      }
    },
    30 * SECOND_MS,
  )
})
