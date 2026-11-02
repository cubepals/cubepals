// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The shared resolver retains immutable explanations of exact selections, omissions and uncertainty. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import type { CatalogDependency } from '../../domain/mods/catalog.ts'
import { resolve } from '../../domain/mods/resolve.ts'
import { catalogLoadersFor } from '../../minecraft/mods.ts'
import { javaFor } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { recordCompilation } from './compilation-records.ts'

describe.skipIf(!hasDatabase)('compiler explanation records', () => {
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

  test('completed and refused plans retain their actual evidence once', async () => {
    const suffix = randomUUID()
    const foreign = publish(h, cdn, { id: `forge-${suffix}`, loaders: ['forge'], bytes: new Uint8Array() })
    const core = publish(h, cdn, {
      id: `universal-${suffix}`,
      loaders: ['fabric', 'forge'],
      bytes: zipBytes({
        'fabric.mod.json': utf8(
          JSON.stringify({
            id: 'universal_server',
            version: '1.0',
            environment: 'server',
            depends: { minecraft: '*' },
          }),
        ),
      }),
      dependencies: [{ kind: 'required', projectId: foreign.projectId, versionId: null }],
    })
    const opaque = publish(h, cdn, {
      id: `unknown-${suffix}`,
      loaders: ['fabric'],
      bytes: utf8('unreadable jar metadata'),
    })
    const target = { gameVersion: '26.3', loader: 'fabric' as const }
    const wanted = [core, opaque].map(({ projectId, versionId }) => ({ projectId, versionId }))
    const plan = await h.app.mods.resolveNew(target, wanted)
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') throw new Error('A proven foreign-loader catalog edge must be omitted')
    if (!plan.decisions) throw new Error('A foreign-loader omission must retain its decision')
    expect(plan.mods.map((mod) => mod.source).length).toBe(2)
    expect(plan.decisions).toMatchObject([
      {
        from: core.projectId,
        projectId: foreign.projectId,
        loader: 'fabric',
        artifactSha512: core.file.sha512,
      },
    ])
    const [record] = await h.db.select().from(schema.modCompilations)
    expect(record?.evidence).toEqual({
      target: { ...target, loaders: catalogLoadersFor(target.loader), java: javaFor(target.gameVersion) },
      requested: wanted,
      selected: plan.mods.map((mod) => ({ name: mod.name, sha512: mod.artifact.sha512 })),
      omitted: plan.decisions,
      conflicts: [],
      unknown: [opaque.versionId],
    })
    expect(JSON.stringify(record?.evidence)).not.toContain(cdn.url)
    await h.app.mods.resolveNew(target, wanted)
    expect((await h.db.select().from(schema.modCompilations)).length).toBe(1)
    const refused = await h.app.mods.resolveNew(target, [
      { projectId: foreign.projectId, versionId: foreign.versionId },
    ])
    expect(refused.kind).toBe('conflicts')
    if (refused.kind !== 'conflicts') throw new Error('A Forge-only request cannot resolve on Fabric')
    const records = await h.db.select().from(schema.modCompilations)
    expect(records.length).toBe(2)
    expect(records.find((row) => row.key !== record?.key)?.evidence).toMatchObject({
      selected: [],
      omitted: [],
      conflicts: refused.conflicts,
    })
  }, 30_000)

  test('an incomplete resolution never becomes completed compiler evidence', () => incompleteCompilation(h))
})

function publish(
  h: Harness,
  cdn: Cdn,
  input: { id: string; loaders: string[]; bytes: Uint8Array; dependencies?: CatalogDependency[] },
) {
  const file = cdn.file(input.id, input.bytes)
  const versionId = `${input.id}-1`
  h.catalog.publish(
    {
      projectId: input.id,
      slug: input.id,
      name: input.id,
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      loaders: input.loaders,
      downloads: 1,
    },
    [
      {
        versionId,
        projectId: input.id,
        versionLabel: '1.0',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: input.loaders,
        gameVersions: ['26.3'],
        publishedAt: new Date(0),
        file,
        dependencies: input.dependencies ?? [],
      },
    ],
  )
  return { projectId: input.id, versionId, file }
}

async function incompleteCompilation(h: Harness) {
  const request = {
    catalog: 'modrinth',
    target: { loader: 'fabric', loaders: ['fabric'], gameVersion: '26.3' },
    wanted: [{ projectId: 'not-loaded-yet' }],
    current: [],
    upgrade: new Set<string>(),
    environment: () => 'server' as const,
  }
  const data = { projects: new Map(), versions: new Map(), fitting: new Map() }
  const result = resolve(request, data)
  expect(result.kind).toBe('need')
  const before = await h.db.select().from(schema.modCompilations)
  await recordCompilation(h.db, request, result, data)
  expect(await h.db.select().from(schema.modCompilations)).toHaveLength(before.length)
}
