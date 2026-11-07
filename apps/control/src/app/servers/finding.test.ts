// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A server found by what an operator calls it (`finding.ts`), on a real database. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ServerFinder } from './finding.ts'

describe.skipIf(!hasDatabase)('finding a server', () => {
  let h: Harness
  let finder: ServerFinder

  beforeAll(async () => {
    h = await startHarness()
    finder = new ServerFinder(h.db)
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  test('by its id, its slug, the address players join, or its name in any case', async () => {
    const owner = await h.user()
    const made = await h.create(owner, { name: 'Void World' })
    const found = async (ref: string) => (await finder.find(ref)).map((s) => s.id)
    expect(await found(made.id)).toEqual([made.id])
    expect(await found(made.slug)).toEqual([made.id])
    expect(await found(`${made.slug}.play.cubepals.com`)).toEqual([made.id])
    expect(await found(`${made.slug.toUpperCase()}.play.cubepals.com:25565`)).toEqual([made.id])
    expect(await found('void world')).toEqual([made.id])
    expect((await finder.find(made.slug))[0]).toMatchObject({ name: 'Void World', slug: made.slug })
    expect(await found('nobody-has-this')).toEqual([])
    expect(await found('  ')).toEqual([])

    // Purged for good: never found.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'purged' })
      .where(eq(schema.minecraftServers.id, made.id))
    expect(await found(made.slug)).toEqual([])
  }, 30_000)
})
