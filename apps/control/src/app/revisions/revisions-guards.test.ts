// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Revision refusals protect the world's newest version and reject stale configuration changes. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { settingsProblems } from '../../domain/revision/revision.ts'
import { playerCapacity } from '../../domain/server/size.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { requestedBy } from '../actor.ts'
import { NotFound } from '../errors.ts'
import { insertRevision, loadRevision, setDesired } from '../servers/persistence.ts'
import { draftOf } from './service.ts'

let h: Harness
beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30 * SECOND_MS)

test.skipIf(!hasDatabase)(
  'invalid settings explain every problem without changing the revision',
  async () => {
    const { owner, id, server, revision } = await world()
    const settings = { ...revision.settings, viewDistance: -1 }
    await expect(
      h.app.revisions.changeSettings(owner, id, settings, crypto.randomUUID()),
    ).rejects.toMatchObject({
      code: 'invalid_settings',
      message: settingsProblems(settings, playerCapacity(server.memoryTier)).join(' '),
    })
    expect((await h.server(id)).desiredRevisionId).toBe(revision.id)
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'modded servers explain why Bedrock and other versions are unavailable',
  async () => {
    const owner = await h.user('Modded owner', 'plus')
    const { id } = await h.create(owner, { loader: 'fabric', gameVersion: '26.3' })
    await h.until(id, 'running', 3 * SECOND_MS)
    await h.settled(id, 3 * SECOND_MS)
    await expect(h.app.revisions.changeBedrock(owner, id, true, crypto.randomUUID())).rejects.toMatchObject({
      code: 'invalid_choice',
      message: 'Bedrock players join only a server without mods.',
    })
    await expect(
      h.app.revisions.changeOtherVersions(owner, id, 'on', crypto.randomUUID()),
    ).rejects.toMatchObject({
      code: 'invalid_choice',
      message: 'Only a Paper server lets players on other versions in.',
    })
  },
  30 * SECOND_MS,
)

for (const runtime of ['same', 'missing', 'different-size'] as const) {
  test.skipIf(!hasDatabase)(
    `live settings with players and ${runtime} applied state`,
    async () => {
      const { owner, id, server, revision } = await world('1.21.1')
      h.minecraft.join(id, { uuid: crypto.randomUUID(), name: 'Player' })
      await h.app.schedules.presenceSync()
      if (runtime === 'missing')
        await h.db
          .update(schema.serverRuntimes)
          .set({ applied: null })
          .where(eq(schema.serverRuntimes.serverId, id))
      if (runtime === 'different-size') {
        const tier = entitlementsFor('plus').allowedMemoryTiers.find((tier) => tier !== server.memoryTier)
        if (!tier) throw new Error('The plan must offer another size')
        await h.db.transaction((tx) => setDesired(tx, server, { memoryTier: tier }))
      }
      const applies = async () => (await h.operations(id)).filter((op) => op.kind === 'apply')
      const count = (await applies()).length
      await h.app.revisions.changeSettings(
        owner,
        id,
        { ...revision.settings, difficulty: revision.settings.difficulty === 'hard' ? 'easy' : 'hard' },
        crypto.randomUUID(),
        { when: 'empty' },
      )
      expect((await applies()).length).toBe(count + (runtime === 'same' ? 1 : 0))
      expect((await h.server(id)).desiredRevisionId).not.toBe(revision.id)
      if (runtime === 'same') await h.settled(id, 3 * SECOND_MS)
      expect((await h.server(id)).lifecycle.status).toBe('running')
    },
    30 * SECOND_MS,
  )
}
afterAll(async () => {
  await h?.close()
})

async function world(gameVersion = '26.3') {
  const owner = await h.user('Revision owner', 'plus')
  const { id } = await h.create(owner, {
    loader: gameVersion === '1.21.1' ? 'paper' : 'vanilla',
    gameVersion,
  })
  await h.until(id, 'running', 3 * SECOND_MS)
  await h.settled(id, 3 * SECOND_MS)
  const server = await h.server(id)
  const revision = await loadRevision(h.db, server.desiredRevisionId)
  return { owner, id, server, revision }
}

for (const scenario of [
  { applied: '26.3', desired: '1.21.1', missing: false },
  { applied: '1.21.1', desired: '26.3', missing: false },
  { applied: '26.3', desired: '26.3', missing: true },
]) {
  test.skipIf(!hasDatabase)(
    `downgrades respect applied ${scenario.applied}, desired ${scenario.desired}, missing ${scenario.missing}`,
    async () => {
      const { owner, id, server, revision } = await world(scenario.applied)
      const pending = await h.db.transaction(async (tx) => {
        const next = await insertRevision(
          tx,
          id,
          {
            ...draftOf(revision),
            gameVersion: scenario.desired,
            basedOnRevisionId: revision.id,
            reason: 'version_changed',
          },
          requestedBy(owner),
        )
        await setDesired(tx, server, { revisionId: next.id })
        return next
      })
      if (scenario.missing)
        await h.db
          .update(schema.serverRuntimes)
          .set({ applied: null })
          .where(eq(schema.serverRuntimes.serverId, id))
      await expect(
        h.app.revisions.changeVersion(
          owner,
          id,
          {
            gameVersion: '1.20.1',
            loader: 'vanilla',
            loaderVersion: null,
            resolved: { basedOn: pending.id, mods: [] },
          },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({
        code: 'version_downgrade',
        message: "This world has run on 26.3, and Minecraft can't open it on an older version.",
      })
      const older = await h.db.transaction((tx) =>
        insertRevision(
          tx,
          id,
          {
            ...draftOf(revision),
            gameVersion: '1.20.1',
            basedOnRevisionId: revision.id,
          },
          requestedBy(owner),
        ),
      )
      await expect(h.app.revisions.rollback(owner, id, older.id, crypto.randomUUID())).rejects.toMatchObject({
        code: 'version_downgrade',
        message:
          'That revision runs 1.20.1, and this world has run on 26.3. Restore a backup from 1.20.1 to go back with its world.',
      })
      expect((await h.server(id)).desiredRevisionId).toBe(pending.id)
    },
    30 * SECOND_MS,
  )
}

test.skipIf(!hasDatabase)(
  'stale requests and missing rollback targets retain the current revision',
  async () => {
    const { owner, id, server, revision } = await world()
    await expect(
      h.app.revisions.changeSettings(owner, id, revision.settings, crypto.randomUUID(), {
        version: server.version + 1,
      }),
    ).rejects.toMatchObject({
      code: 'changed_meanwhile',
      message: 'This server changed since you looked at it. Look at it again, then try once more.',
    })
    await expect(
      h.app.revisions.changeMods(owner, id, { basedOn: crypto.randomUUID(), mods: [] }, crypto.randomUUID()),
    ).rejects.toMatchObject({
      code: 'changed_meanwhile',
      message:
        "The server's configuration changed while this was being prepared. Look at it again, then try once more.",
    })
    await expect(
      h.app.revisions.rollback(owner, id, crypto.randomUUID(), crypto.randomUUID()),
    ).rejects.toThrow(new NotFound('Revision'))
    expect((await h.server(id)).desiredRevisionId).toBe(revision.id)
  },
  30 * SECOND_MS,
)
