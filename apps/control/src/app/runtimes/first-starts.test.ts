// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a new server first runs in a deployment with two runtimes: a rule that names its owner by
 * the account id Better Auth gave them, and a first start that can't come up on its runtime, which
 * moves on to the next. `fake` is the default, as Fly is on staging, and `canary` stands in for the
 * other runtime. Everything else about several runtimes is `hybrid.test.ts`'s.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRuntime } from '../servers/persistence.ts'

const OPERATOR = 'operator:test'

describe.skipIf(!hasDatabase)('a new server’s first start on several runtimes', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({
      capabilities: { archives: null, billing: null },
      otherRuntimes: [{ provider: 'canary' }],
    })
  }, 30_000)

  afterEach(async () => {
    await h.db.update(schema.runtimeRules).set({ enabled: false })
    canary().failBootWhen(() => null)
  })

  afterAll(async () => {
    await h.close()
  })

  const canary = () => {
    const found = h.runtimes.get('canary')
    if (found === undefined) throw new Error('no canary runtime')
    return found
  }
  const bound = (id: string) => loadRuntime(h.db, id, [...h.runtimes.keys()])
  const running = async (owner: UserActor) => {
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return server.id
  }

  test('a rule names an account by its Better Auth id, which is no UUID', async () => {
    const id = 'Kx7rT2mQ9vLp4sWn8bYc3dFh6jGz1aEu'
    await h.db
      .insert(schema.users)
      .values({ id, name: 'Named', email: `${id}@example.test`, emailVerified: true })
    await h.db.insert(schema.accountStanding).values({ userId: id, plan: 'plus' })
    const rule = await h.app.placement.addRule({ provider: 'canary', percent: 100, accounts: [id] }, OPERATOR)
    const [stored] = await h.db
      .select({ accounts: schema.runtimeRules.accounts })
      .from(schema.runtimeRules)
      .where(eq(schema.runtimeRules.id, rule.id))
    expect(stored?.accounts).toEqual([id])
    expect((await bound(await running({ kind: 'user', userId: id }))).provider).toBe('canary')
  })

  test('a new server that can’t come up on the canary starts on the next runtime, on record', async () => {
    const owner = await h.user('Stalled', 'plus')
    await h.app.placement.addRule({ provider: 'canary', percent: 100 }, OPERATOR)
    canary().failBootWhen(() => 'the sandbox exited')
    const id = await running(owner)
    expect((await bound(id)).provider).toBe('fake')
    expect(h.runtime.machine(id)?.state).toBe('running')
    // What the canary began for it is gone, rather than left running beside it.
    expect(canary().machine(id)).toBeNull()
    const decisions = (await h.app.placement.where(id)).decisions
    expect(decisions.map((d) => d.kind)).toEqual(['fell_back', 'placed'])
    expect(decisions[0]).toMatchObject({ provider: 'fake', fromProvider: 'canary' })
    expect(decisions[0]?.reason).toMatch(/^It stopped while being set up/)
  })

  test('a server that ran once never moves for a start that can’t come up', async () => {
    const owner = await h.user('Settled', 'plus')
    await h.app.placement.addRule({ provider: 'canary', percent: 100 }, OPERATOR)
    const id = await running(owner)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    canary().failBootWhen(() => 'the sandbox exited')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'failed')
    await h.settled(id)
    expect((await bound(id)).provider).toBe('canary')
    expect((await h.app.placement.where(id)).decisions.map((d) => d.kind)).toEqual(['placed'])
  })
})
