// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server that came up without all it was told to load knows it: Paper goes on past a plugin it
 * can't load (production's 1.21.11 Skyblock, 2026-10-11, ran as a plain world while Cubepals said
 * it was online), so what the start said it left out is kept, shown, and cleared by a start that
 * loads everything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRuntime } from '../servers/persistence.ts'

describe.skipIf(!hasDatabase)('what a start left out', () => {
  let h: Harness
  const cdn = new Cdn()

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('a plugin Paper couldn’t load is refused before play and its owner can remove it', async () => {
    // AuraSkills, RPG survival's plugin, published as bytes Paper can't load.
    h.catalog.publish(
      {
        projectId: 'uDdZAVls',
        slug: 'auraskills',
        name: 'AuraSkills',
        summary: '',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: 'aura-1',
          projectId: 'uDdZAVls',
          versionLabel: '2.4.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper'],
          gameVersions: ['26.2'],
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file('aura-1', Buffer.from('not a jar Paper can load')),
          dependencies: [],
        },
      ],
    )
    const owner = await h.user('Mira', 'plus')
    const made = await h.create(owner, { from: { kind: 'template', key: 'rpg' } })
    await h.settled(made.id)
    expect((await h.server(made.id)).lifecycle.status).toBe('failed')
    expect((await loadRuntime(h.db, made.id, ['fake'])).handle).toBeNull()
    expect((await h.operations(made.id)).at(-1)?.error).toContain('AuraSkills')

    // Without it, everything it was told to load loads, and nothing is said any more.
    await h.app.mods.apply(owner, made.id, { remove: ['uDdZAVls'] }, [], randomUUID())
    await h.settled(made.id)
    expect((await h.app.queries.get(owner, made.id)).notLoaded).toEqual([])
  }, 30_000)
})
