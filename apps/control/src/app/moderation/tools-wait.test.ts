// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moderation tools switched while players are on: the change that brings their plugins waits for
 * everyone to leave where the owner chose to, and restarts the server now where they didn't.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { CHATSENTINEL, LIBERTYBANS, LUCKPERMS, runsModeration } from '../../minecraft/moderation.ts'
import { offeredVersions, supports } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { ModerationService } from './service.ts'

let h: Harness
let moderation: ModerationService
const cdn = new Cdn()

async function prepare() {
  await cdn.start()
  h = await startHarness()
  // As the API builds it (main.node.ts).
  moderation = new ModerationService({
    db: h.db,
    events: h.events,
    policy: h.app.policy,
    transitions: h.app.transitions,
    mods: h.app.mods,
  })
  for (const [projectId, name] of [
    [LIBERTYBANS, 'LibertyBans'],
    [LUCKPERMS, 'LuckPerms'],
    [CHATSENTINEL, 'ChatSentinel'],
  ] as const)
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name,
        summary: `${name}, for tests`,
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: `${projectId}-1`,
          projectId,
          versionLabel: '1',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper'],
          gameVersions: offeredVersions().map((offered) => offered.id),
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file(`${name}-1`),
          dependencies: [],
        } satisfies CatalogVersion,
      ],
    )
}

async function close() {
  await h.close()
  cdn.close()
}

const occupied = async () => {
  const owner = await h.user(undefined, 'plus')
  const { id } = await h.create(owner, {
    loader: 'paper',
    gameVersion: offeredVersions().find((offered) => supports(offered.id, 'paper'))?.id ?? '',
  })
  await h.until(id, 'running')
  await h.settled(id)
  h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
  await h.app.schedules.presenceSync()
  return { owner, id }
}

const applies = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply')
const desiredMods = async (id: string) =>
  (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).mods

describe.skipIf(!hasDatabase)('the moderation tools while players are on', () => {
  beforeAll(prepare, 30_000)
  afterAll(close)

  test('wait for everyone to leave where the owner chose to, saved as what the server runs next', async () => {
    const { owner, id } = await occupied()
    await moderation.setTools(owner, id, { enabled: true, chatFilter: false, when: 'empty' }, randomUUID())
    expect(await applies(id)).toHaveLength(0)
    expect(runsModeration(await desiredMods(id))).toBe(true)
    const waiting = (await h.app.queries.get(owner, id)).waiting
    expect(waiting?.changes.find((change) => change.field === 'mods')).toBeDefined()
  }, 60_000)

  test('restart the server now where the owner said so', async () => {
    const { owner, id } = await occupied()
    await moderation.setTools(owner, id, { enabled: true, chatFilter: false, when: 'now' }, randomUUID())
    expect(await applies(id)).toHaveLength(1)
    await h.settled(id)
  }, 60_000)
})
