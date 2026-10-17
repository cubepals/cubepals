// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Check marks and seals in a server's name and description, refused whoever gives them, and the
 * words Cubepals and Official in an address, an operator's alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

describe.skipIf(!hasDatabase)('check marks, seals and the words Cubepals and Official', () => {
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

  test('Cubepals and Official stay an operator’s in an address, and a name with its own address may say them', async () => {
    const owner = await h.user()
    // No address is found for the name alone; one picked by hand takes it.
    expect(await refusal(h.create(owner, { name: 'Cubepals Official' }))).toBe(
      'slug_taken: We could not find a free address for that name. Pick one yourself.',
    )
    const made = await h.create(owner, { name: 'Cubepals Official', slug: 'moss-hollow' })
    expect(made.name).toBe('Cubepals Official')
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
})
