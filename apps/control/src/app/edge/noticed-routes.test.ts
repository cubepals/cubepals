// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on an account, on the edge's routes: every route of every server the
 * account owns carries it as the game reads it, running or asleep, beside the server's own
 * message, which stays as its owner saved it; nothing is woken or refreshed for it; and it goes
 * from the routes once cleared.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

const ADA: Actor = { kind: 'operator', name: 'ada' }

describe.skipIf(!hasDatabase)('an account’s notice on the edge', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('is on each of its servers’ routes, running and asleep, and goes when cleared', async () => {
    const owner = await h.user('Noticed', 'plus')
    const awake = await h.create(owner, { name: 'Awake' })
    const asleep = await h.create(owner, { name: 'Asleep' })
    const other = await h.create(await h.user('Other'), { name: 'Other' })
    for (const { id } of [awake, asleep, other]) {
      await h.until(id, 'running')
      await h.settled(id)
    }
    await h.app.servers.stop(owner, asleep.id, randomUUID(), 'idle')
    await h.until(asleep.id, 'stopped')
    await h.settled(asleep.id)
    const before = (await h.operations(asleep.id)).length

    await h.app.accounts.notices.set(ADA, owner.userId, { text: '&cUnder review &lnow', limitAt: null })
    const { routes } = await h.app.edge.routes()
    const of = (slug: string) => routes.filter((r) => r.hostname.startsWith(`${slug}.`))
    const ours = [...of(awake.slug), ...of(asleep.slug)]
    expect(ours.length).toBeGreaterThan(0)
    for (const route of ours) expect(route.notice).toBe('§cUnder review §lnow')
    expect(of(asleep.slug)[0]?.state).toBe('asleep')
    expect(of(awake.slug)[0]?.state).toBeUndefined()
    for (const route of of(other.slug)) expect(route.notice).toBeUndefined()
    // The owner's own message is as they saved it, and nothing was started for the notice.
    expect((await h.server(asleep.id)).lifecycle.status).toBe('stopped')
    expect(await h.operations(asleep.id)).toHaveLength(before)

    await h.app.accounts.notices.clear(ADA, owner.userId)
    for (const route of (await h.app.edge.routes()).routes) expect(route.notice).toBeUndefined()
  }, 60_000)
})
