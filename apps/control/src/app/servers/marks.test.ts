// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Check marks and seals in a server's name and description, refused whoever gives them; the words
 * Cubepals, Official, Verified and Staff in them, refused for a server not marked official; and
 * Cubepals and Official in an address, an operator's alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

describe.skipIf(!hasDatabase)(
  'check marks, seals and the words Cubepals, Official, Verified and Staff',
  () => {
    let h: Harness
    const operator: Actor = { kind: 'operator', name: 'ada' }

    beforeAll(async () => {
      h = await startHarness()
    }, 30_000)

    afterAll(async () => {
      await h.close()
    })

    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
      )

    test('a name or description with a check mark or a seal is refused, whoever gives it', async () => {
      const owner = await h.user()
      for (const mark of ['✓', '✔️', '☑', '✅', '🗸', '🏅']) {
        expect(await refusal(h.create(owner, { name: `Arcade ${mark}` }))).toBe(
          'invalid_name: Names can’t use check marks or seals.',
        )
      }
      const made = await h.create(owner, { name: 'Castle Builders' })
      expect(await refusal(h.app.servers.saveIdentity(owner, made.id, { name: 'Castle ✔' }))).toBe(
        'invalid_name: Names can’t use check marks or seals.',
      )
      expect(await refusal(h.app.servers.saveIdentity(operator, made.id, { name: 'Castle ✔' }))).toBe(
        'invalid_name: Names can’t use check marks or seals.',
      )
      expect(await refusal(h.app.servers.saveIdentity(owner, made.id, { description: 'Verified ✅' }))).toBe(
        'invalid_choice: Descriptions can’t use check marks or seals.',
      )
      // One it had before keeps, while the rest changes.
      await h.db
        .update(schema.minecraftServers)
        .set({ name: 'Castle ✓', description: 'Since ✓' })
        .where(eq(schema.minecraftServers.id, made.id))
      expect(
        await h.app.servers.saveIdentity(owner, made.id, {
          name: 'Castle ✓',
          description: 'Since ✓',
          tags: ['pvp'],
        }),
      ).toMatchObject({ name: 'Castle ✓', description: 'Since ✓', tags: ['pvp'] })
    })

    test('a server not marked official can’t be named or described as Cubepals, Official, Verified or Staff', async () => {
      const owner = await h.user()
      for (const name of [
        'Cubepals Official',
        'Cube pals SMP',
        'Cubepal5',
        'Verified Survival',
        'Staff',
        'Оfficial',
      ]) {
        expect(await refusal(h.create(owner, { name, slug: 'moss-hollow' }))).toBe(
          'invalid_name: Names can’t say Cubepals, Official, Verified or Staff.',
        )
      }
      const made = await h.create(owner, { name: 'Moss Hollow', slug: 'moss-hollow' })
      expect(
        await refusal(h.app.servers.saveIdentity(owner, made.id, { name: 'Official Moss Hollow' })),
      ).toBe('invalid_name: Names can’t say Cubepals, Official, Verified or Staff.')
      expect(
        await refusal(h.app.servers.saveIdentity(operator, made.id, { name: 'Moss Hollow Staff' })),
      ).toBe('invalid_name: Names can’t say Cubepals, Official, Verified or Staff.')
      expect(
        await refusal(
          h.app.servers.saveIdentity(owner, made.id, { description: 'The official Cubepals world' }),
        ),
      ).toBe('invalid_choice: Descriptions can’t say Cubepals, Official, Verified or Staff.')
      expect(
        await h.app.servers.saveIdentity(owner, made.id, {
          name: 'Unofficial Moss',
          description: 'Staffordshire',
        }),
      ).toMatchObject({ name: 'Unofficial Moss', description: 'Staffordshire' })
    })

    test('a server marked official may say them, and a name or description a server already has stays', async () => {
      const owner = await h.user()
      const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
      await h.db.insert(schema.platformAdmins).values({ userId: admin.userId, grantedBy: 'test' })
      const ours = await h.create(owner, { name: 'Duels', slug: 'duels-table' })
      await h.app.listings.markOfficial(admin, ours.id, true, 'runs it')
      expect(
        await h.app.servers.saveIdentity(owner, ours.id, {
          name: 'Cubepals Duels',
          description: 'The official duels server.',
        }),
      ).toMatchObject({ name: 'Cubepals Duels', description: 'The official duels server.' })
      // Taken off, it keeps what it has, and can't take them up again.
      await h.app.listings.markOfficial(admin, ours.id, false, 'stopped')
      expect(
        await h.app.servers.saveIdentity(owner, ours.id, {
          name: 'Cubepals Duels',
          description: 'The official duels server.',
          tags: ['pvp'],
        }),
      ).toMatchObject({ name: 'Cubepals Duels', tags: ['pvp'] })
      expect(await refusal(h.app.servers.saveIdentity(owner, ours.id, { name: 'Cubepals Duels 2' }))).toBe(
        'invalid_name: Names can’t say Cubepals, Official, Verified or Staff.',
      )
    })

    test('Cubepals and Official stay an operator’s in an address', async () => {
      const owner = await h.user()
      const made = await h.create(owner, { name: 'Lantern Bay', slug: 'lantern-bay' })
      // The platform's own host is nobody's.
      expect(await refusal(h.app.servers.changeAddress(operator, made.id, 'cubepals'))).toBe(
        'slug_invalid: Addresses use 3–40 lowercase letters, numbers and dashes.',
      )
      for (const slug of ['official', 'cubepals-official', 'off1cial', 'cube-pals2', 'cubepal5']) {
        expect(await refusal(h.app.servers.changeAddress(owner, made.id, slug))).toBe(
          'slug_taken: That address is taken — try adding a word.',
        )
      }
    })
  },
)
