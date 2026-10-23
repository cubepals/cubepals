// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A template's preview from what the control plane kept: the catalog asked once for everyone, and
 * the plan still judged for each person who asks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { TEMPLATE_KEPT_MS } from './resolved-templates.ts'

describe.skipIf(!hasDatabase)('a template’s preview, kept', () => {
  let h: Harness
  const cdn = new Cdn()

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness({ templatesKeptMs: TEMPLATE_KEPT_MS })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('asks the catalog once, and judges each plan afresh', async () => {
    // AuraSkills as Modrinth listed it on 2026-10-09, under its real project id.
    h.catalog.publish(
      {
        projectId: 'uDdZAVls',
        slug: 'uDdZAVls',
        name: 'AuraSkills',
        summary: '',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: 'uDdZAVls-1',
          projectId: 'uDdZAVls',
          versionLabel: '1.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper', 'spigot'],
          gameVersions: ['26.1.2', '26.2', '26.3'],
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file('uDdZAVls-1'),
          dependencies: [],
        },
      ],
    )
    const asked: string[] = []
    const versions = h.catalog.versions.bind(h.catalog)
    h.catalog.versions = (projectId, target) => {
      asked.push(projectId)
      return versions(projectId, target)
    }
    const plus = await h.app.queries.setupPreview(await h.user('Ari', 'plus'), {
      kind: 'template',
      key: 'rpg',
    })
    const before = asked.length
    expect(before).toBeGreaterThan(0)
    const free = await h.app.queries.setupPreview(
      await h.user('Noor'),
      { kind: 'template', key: 'rpg' },
      '10',
    )
    expect(asked).toHaveLength(before)
    expect(free).toMatchObject({ gameVersion: plus.gameVersion, mods: plus.mods })
    expect(plus.size.allowed).toBe(true)
    expect(free.size).toMatchObject({ allowed: false, plan: 'plus' })
  }, 30_000)
})
