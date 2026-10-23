// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Names held back from players, end to end: brand names, names held for Cubepals' own servers,
 * addresses Cubepals keeps, its example address and offensive ones, as a player, an admin and an operator meet them, and what servers that already
 * have one keep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { Slug } from '../../domain/server/slug.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

const operator: Actor = { kind: 'operator', name: 'ada' }

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
  )

describe.skipIf(!hasDatabase)('held and offensive names', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /** Gives a server an address or name as if it had it before these rules. */
  const had = (id: string, change: { slug?: Slug; name?: string }) =>
    h.db.update(schema.minecraftServers).set(change).where(eq(schema.minecraftServers.id, id))

  test('a player is told a name held for Cubepals’ own servers is taken, and offered another', async () => {
    const owner = await h.user()
    expect(await h.app.servers.suggestAddress(owner, 'Duels')).toMatchObject({
      slug: expect.stringMatching(/^duels-\d{4}$/),
      available: true,
    })
    expect(await h.app.servers.suggestAddress(owner, '', 'duels')).toMatchObject({ available: false })
    const made = await h.create(owner, { name: 'Duels' })
    expect(made.slug).toMatch(/^duels-\d{4}$/)
    expect(await refusal(h.create(owner, { name: 'Skyblock', slug: 'skyblock' }))).toBe(
      'slug_taken: That address is taken — try adding a word.',
    )
    expect(await refusal(h.app.servers.changeAddress(owner, made.id, 'pvp'))).toBe(
      'slug_taken: That address is taken — try adding a word.',
    )
    expect(await refusal(h.app.servers.changeAddress(owner, made.id, 'cubepals1'))).toBe(
      'slug_taken: That address is taken — try adding a word.',
    )
  })

  test('an admin gives one held for Cubepals’ own servers; only an operator gives a brand name', async () => {
    const owner = await h.user('Steve', 'plus')
    const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
    const one = await h.create(owner, { name: 'Lobby one' })
    const two = await h.create(owner, { name: 'Lobby two' })
    expect(await h.app.servers.suggestAddress(admin, '', 'lobby')).toMatchObject({ available: true })
    expect(String((await h.app.servers.changeAddress(admin, one.id, 'lobby')).slug)).toBe('lobby')
    expect(await refusal(h.app.servers.changeAddress(admin, two.id, 'official'))).toBe(
      'slug_taken: That address is taken — try adding a word.',
    )
    expect(String((await h.app.servers.changeAddress(operator, two.id, 'official')).slug)).toBe('official')
    expect(String((await h.app.servers.changeAddress(operator, two.id, 'hub')).slug)).toBe('hub')
  })

  test('an offensive name or address is refused without saying the word back', async () => {
    const owner = await h.user('Steve', 'plus')
    expect(await h.app.servers.suggestAddress(owner, 'Sh1t Show')).toEqual({
      slug: '',
      joinAddress: '',
      available: false,
    })
    expect(await h.app.servers.suggestAddress(owner, '', 'f-u-c-k')).toMatchObject({ available: false })
    expect(await refusal(h.create(owner, { name: 'n i g g e r' }))).toBe('invalid_name: Pick another name.')
    expect(await refusal(h.create(owner, { name: 'Fine name', slug: 'cunt-world' }))).toBe(
      'slug_invalid: Pick another name.',
    )
    const made = await h.create(owner, { name: 'Scunthorpe' })
    expect(String(made.slug)).toBe('scunthorpe')
    expect(await refusal(h.app.servers.saveIdentity(owner, made.id, { name: 'Fuuuck' }))).toBe(
      'invalid_name: Pick another name.',
    )
    expect(await refusal(h.app.servers.changeAddress(owner, made.id, 'shit-hole'))).toBe(
      'slug_invalid: Pick another name.',
    )
    expect(await refusal(h.app.servers.changeAddress(operator, made.id, 'shit-hole'))).toBe(
      'slug_invalid: Pick another name.',
    )
    expect((await h.server(made.id)).name).toBe('Scunthorpe')
  })

  test('a server that already has such a name or address keeps it, and is reached at it', async () => {
    const owner = await h.user()
    const made = await h.create(owner, { name: 'Old timers' })
    await had(made.id, { slug: 'survival' as Slug, name: 'Shit Show' })
    const kept = await h.app.servers.saveIdentity(owner, made.id, {
      name: 'Shit Show',
      description: 'Since before the rules',
    })
    expect(kept).toMatchObject({ slug: 'survival', name: 'Shit Show', description: 'Since before the rules' })
    expect(String((await h.app.servers.changeAddress(owner, made.id, 'survival')).slug)).toBe('survival')
    await h.until(made.id, 'running')
    const { routes } = await h.app.edge.routes()
    expect(routes.map((r) => r.hostname)).toContain('survival.play.test')
  })

  test('a server that already has an address held for Cubepals’ own keeps it', async () => {
    const owner = await h.user()
    const made = await h.create(owner, { name: 'Testing grounds' })
    await had(made.id, { slug: 'testing' as Slug })
    expect(String((await h.app.servers.changeAddress(owner, made.id, 'testing')).slug)).toBe('testing')
    expect(String((await h.server(made.id)).slug)).toBe('testing')
  })

  test('Browse leaves out a listing whose name is offensive, and tells its owner to pick another', async () => {
    const owner = await h.user()
    const made = await h.create(owner, { name: 'Castle Builders' })
    await h.until(made.id, 'running')
    await h.settled(made.id)
    await h.app.listings.setPublic(owner, made.id, true)
    expect((await h.app.listingQueries.own(owner, made.id))?.visible).toBe(true)
    await had(made.id, { name: 'Fuck Castle' })
    await h.app.listings.reevaluate([made.id])
    expect(await h.app.listingQueries.own(owner, made.id)).toMatchObject({
      visible: false,
      reasons: [{ code: 'offensive_name' }],
    })
    const { listings } = await h.app.listingQueries.browse({ search: '', tag: null, offset: 0 })
    expect(listings.map((l) => l.serverId)).not.toContain(made.id)
    await h.app.servers.saveIdentity(owner, made.id, { name: 'Castle Builders' })
    await h.app.listings.reevaluate([made.id])
    expect((await h.app.listingQueries.own(owner, made.id))?.visible).toBe(true)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('addresses Cubepals keeps', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /** Addresses Cubepals keeps for its own server, and its example address, by the name that suggests each. */
  const HELD = [
    ['Sunset Valley', 'sunset-valley'],
    ['Copper Cove', 'copper-cove'],
    ['Maple Hollow', 'maple-hollow'],
    ['Your Server', 'your-server'],
  ] as const

  for (const [name, slug] of HELD)
    test(`${slug}, kept for Cubepals' own server or its example, is taken for everyone, operators too`, async () => {
      const owner = await h.user('Steve', 'plus')
      const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
      const numbered = new RegExp(`^${slug}-\\d{4}$`)
      expect(await h.app.servers.suggestAddress(owner, name)).toMatchObject({
        slug: expect.stringMatching(numbered),
        available: true,
      })
      for (const actor of [owner, admin, operator])
        expect(await h.app.servers.suggestAddress(actor, '', slug)).toMatchObject({
          available: false,
        })
      expect(await refusal(h.create(owner, { name, slug }))).toBe(
        'slug_taken: That address is taken — try adding a word.',
      )
      const made = await h.create(owner, { name })
      expect(made.slug).toMatch(numbered)
      for (const actor of [owner, admin, operator])
        expect(await refusal(h.app.servers.changeAddress(actor, made.id, slug))).toBe(
          'slug_taken: That address is taken — try adding a word.',
        )
    })
})
