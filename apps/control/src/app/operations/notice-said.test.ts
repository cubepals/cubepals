// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on an account, said in game by the pass that reads who is on, on a real
 * database: on the account's running servers, to someone new, again after ten minutes, to nobody
 * when nobody is on, never once it is cleared, and without stopping the pass when the console
 * won't say it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

const ADA: Actor = { kind: 'operator', name: 'ada' }
const NOTICE = '&cThis account is under review'

describe.skipIf(!hasDatabase)('an account’s notice in game', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async (name: string) => {
    const owner = await h.user(name)
    const server = await h.create(owner, { name })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }

  test('is said on the account’s running servers: to someone new, again in ten minutes, never to nobody', async () => {
    const { owner, id } = await running('Chatty')
    const notices = h.app.accounts.notices
    const said = () => h.minecraft.said(id).filter((line) => line.includes('under review'))
    await notices.set(ADA, owner.userId, { text: NOTICE, limitAt: null })
    // Nobody on: nothing said.
    await h.app.schedules.presenceSync()
    expect(said()).toEqual([])
    const alex = { uuid: randomUUID(), name: 'Alex' }
    h.minecraft.join(id, alex)
    await h.app.schedules.presenceSync()
    expect(said()).toEqual(['[Cubepals] §cThis account is under review'])
    // Alex was on last time: not again yet.
    await h.app.schedules.presenceSync()
    expect(said()).toHaveLength(1)
    // Someone new hears it, and Alex with them.
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Steve' })
    await h.app.schedules.presenceSync()
    expect(said()).toHaveLength(2)
    // Ten minutes on, everyone hears it again: as if it was said that long ago.
    await h.db
      .update(schema.noticeSaid)
      .set({ saidAt: new Date(Date.now() - 10 * MINUTE_MS) })
      .where(eq(schema.noticeSaid.serverId, id))
    await h.app.schedules.presenceSync()
    expect(said()).toHaveLength(3)
    // A new notice is heard at the next reading, by whoever is on, even where a pass that read the
    // old one kept, after the new one was set, that it had just said it.
    const [kept] = await h.db.select().from(schema.noticeSaid).where(eq(schema.noticeSaid.serverId, id))
    await notices.set(ADA, owner.userId, { text: '&eNew words', limitAt: null })
    if (kept === undefined) throw new Error('Nothing was kept of the notice')
    await h.db.insert(schema.noticeSaid).values({ ...kept, saidAt: new Date() })
    await h.app.schedules.presenceSync()
    expect(h.minecraft.said(id).at(-1)).toBe('[Cubepals] §eNew words')
    await notices.clear(ADA, owner.userId)
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Sam' })
    await h.app.schedules.presenceSync()
    expect(said()).toHaveLength(3)
  }, 60_000)

  test('a console that won’t say it leaves the pass whole, and it is said at the next reading', async () => {
    const { owner, id } = await running('Refusing')
    await h.app.accounts.notices.set(ADA, owner.userId, { text: NOTICE, limitAt: null })
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    h.minecraft.refuseCommands(/^tellraw/)
    try {
      await h.app.schedules.presenceSync()
    } finally {
      h.minecraft.refuseCommands(null)
    }
    // The pass went on: who is on was kept.
    const present = await h.db
      .select()
      .from(schema.serverPresence)
      .where(eq(schema.serverPresence.serverId, id))
    expect(present.map((p) => p.playerName)).toEqual(['Alex'])
    expect(h.minecraft.said(id).filter((line) => line.includes('under review'))).toEqual([])
    await h.app.schedules.presenceSync()
    expect(h.minecraft.said(id).filter((line) => line.includes('under review'))).toHaveLength(1)
  }, 60_000)
})
