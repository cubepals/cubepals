// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Versions Cubepals tested past their catalog's listing: each record covers one exact version on
 * one target, resolving a setup honours them only there, and the admins' view says which
 * templates keep up, which a record carries, and which lag.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { CatalogProject, CatalogVersion } from '../../domain/mods/catalog.ts'
import { type CatalogData, type ResolveRequest, resolve } from '../../domain/mods/resolve.ts'
import { FakeCatalog } from '../../infra/fake/fake-catalog.ts'
import { catalogLoadersFor } from '../../minecraft/mods.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Template } from '../setups/templates.ts'
import { compatibilityView } from './templates-view.ts'
import { TESTED, testedOn } from './tested.ts'

/** BentoBox and its addons as Modrinth listed them on 2026-10-09: ids, versions and releases. */
const BENTOBOX = [
  { projectId: 'aBVLHiAW', versionId: 'Wm9asg4I', name: 'BentoBox', lists: ['26.1.2', '26.2', '26.3'] },
  { projectId: 'ASGn77Qd', versionId: '3kLVOQCM', name: 'BSkyBlock', lists: ['1.21.11', '26.1', '26.1.1'] },
  { projectId: 'qq7CK8U4', versionId: 'SO3SQFxw', name: 'AOneBlock', lists: ['26.1', '26.1.1', '26.1.2'] },
  { projectId: 'OWzL9XSJ', versionId: '55hL6XOg', name: 'Level', lists: ['26.1', '26.1.1', '26.1.2'] },
  { projectId: 'P08aFayx', versionId: '4yAHWSTz', name: 'Warps', lists: ['26.1', '26.1.1', '26.1.2'] },
] as const

const PROJECTS = BENTOBOX.map(
  (plugin): CatalogProject => ({
    projectId: plugin.projectId,
    slug: plugin.projectId,
    name: plugin.name,
    summary: '',
    iconUrl: null,
    environments: ['server_only'],
    downloads: 1,
    gameVersions: [...plugin.lists],
    state: 'approved',
  }),
)

/** Each plugin's one version, published for the releases `lists` names. */
const versionsOn = (file: (name: string) => CatalogVersion['file']): CatalogVersion[] =>
  BENTOBOX.map((plugin) => ({
    versionId: plugin.versionId,
    projectId: plugin.projectId,
    versionLabel: '1.0',
    channel: 'release',
    state: 'listed',
    environment: 'server_only',
    loaders: ['paper', 'purpur'],
    gameVersions: [...plugin.lists],
    publishedAt: new Date(Date.UTC(2026, 8, 1)),
    file: file(plugin.versionId),
    dependencies: [],
  }))

const fileAt = (name: string) => ({
  url: `https://cdn.test/${name}`,
  sha512: name,
  sizeBytes: 1,
  fileName: name,
})

function publish(catalog: FakeCatalog, file: (name: string) => CatalogVersion['file']) {
  const versions = versionsOn(file)
  for (const project of PROJECTS)
    catalog.publish(
      project,
      versions.filter((v) => v.projectId === project.projectId),
    )
}

describe('tested versions', () => {
  test('each record covers one exact version on one release and server type', () => {
    expect(TESTED).toHaveLength(8)
    for (const record of TESTED) {
      expect(record.versionId).toMatch(/^[A-Za-z0-9]{8}$/)
      expect(record.testedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(record.evidence).toContain('cubepals/cubepals#10')
    }
    expect(testedOn(TESTED, { gameVersion: '26.2', loader: 'paper' }).map((r) => r.name)).toEqual([
      'BSkyBlock',
      'AOneBlock',
      'Level',
      'Warps',
    ])
    // Nothing the boot test didn't run: another release, another server type.
    expect(testedOn(TESTED, { gameVersion: '26.3', loader: 'paper' })).toEqual([])
    expect(testedOn(TESTED, { gameVersion: '26.2', loader: 'fabric' })).toEqual([])
  })

  test('a template lags, is covered by a record, or keeps up', async () => {
    const catalog = new FakeCatalog()
    publish(catalog, (name) => ({
      url: `https://cdn.test/${name}`,
      sha512: name,
      sizeBytes: 1,
      fileName: name,
    }))
    const template = (key: string, projectIds: string[]): Template => ({
      key,
      title: key,
      blurb: '',
      icon: null,
      setup: {
        loader: 'paper',
        mods: projectIds.map((projectId) => ({ catalog: 'modrinth', projectId })),
        settings: {},
        world: { levelType: 'minecraft:normal', hardcore: false },
      },
    })
    const templates = [
      template('bentobox', ['aBVLHiAW']),
      template('oneblock', ['aBVLHiAW', 'qq7CK8U4', 'OWzL9XSJ']),
      template('vanilla', []),
    ]
    const without = await compatibilityView(catalog, templates, [])
    expect(without.templates).toEqual([
      {
        key: 'bentobox',
        title: 'bentobox',
        loaderLabel: 'Paper',
        newest: '26.2',
        status: 'current',
        behind: [],
        tested: [],
      },
      {
        key: 'oneblock',
        title: 'oneblock',
        loaderLabel: 'Paper',
        newest: '26.2',
        status: 'lagging',
        behind: [
          { name: 'AOneBlock', newestListed: '26.1.2' },
          { name: 'Level', newestListed: '26.1.2' },
        ],
        tested: [],
      },
    ])
    const covered = await compatibilityView(catalog, templates, TESTED)
    expect(covered.templates[1]).toMatchObject({ status: 'covered', behind: [] })
    expect(covered.templates[1]?.tested.map((r) => [r.name, r.gameVersion, r.testedOn])).toEqual([
      ['AOneBlock', '26.2', '2026-10-09'],
      ['Level', '26.2', '2026-10-09'],
    ])
    expect(covered.tested).toHaveLength(TESTED.length)
    // A record for one addon leaves the other holding the template back.
    const one = TESTED.filter((r) => r.name === 'Level')
    expect((await compatibilityView(catalog, templates, one)).templates[1]).toMatchObject({
      status: 'lagging',
      behind: [{ name: 'AOneBlock', newestListed: '26.1.2' }],
    })
  })
})

describe('a BentoBox setup on Paper 26.2', () => {
  const target = { gameVersion: '26.2', loader: 'paper' } as const
  const wanted = BENTOBOX.map(({ projectId }) => ({ projectId }))

  test('resolves only with the records the boot test earned', () => {
    const versions = versionsOn(fileAt)
    // As the catalog answers: only what it lists for 26.2 is fitting.
    const data: CatalogData = {
      projects: new Map(PROJECTS.map((project) => [project.projectId, project])),
      fitting: new Map(
        PROJECTS.map((p) => [
          p.projectId,
          versions.filter((v) => v.projectId === p.projectId && v.gameVersions.includes('26.2')),
        ]),
      ),
      versions: new Map(versions.map((v) => [v.versionId, v])),
    }
    const request: ResolveRequest = {
      catalog: 'modrinth',
      target: { gameVersion: target.gameVersion, loaders: catalogLoadersFor(target.loader) },
      wanted,
      current: [],
      upgrade: new Set(),
      environment: () => 'server',
    }
    expect(resolve(request, data)).toEqual({
      kind: 'conflicts',
      // Every addon; BentoBox itself lists 26.2.
      conflicts: BENTOBOX.slice(1).map(({ projectId, name }) => ({
        kind: 'no_fitting_version',
        mod: name,
        projectId,
      })),
    })
    const tested = testedOn(TESTED, target).map(({ projectId, versionId }) => ({ projectId, versionId }))
    expect(resolve({ ...request, tested }, data)).toMatchObject({ kind: 'resolved' })
  })
})

describe.skipIf(!hasDatabase)('a BentoBox server made on Paper 26.2', () => {
  const cdn = new Cdn()
  let h: Harness

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    publish(h.catalog, (name) => cdn.file(name))
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('resolves with the records the boot test earned', async () => {
    const plan = await h.app.mods.resolveNew(
      { gameVersion: '26.2', loader: 'paper' },
      BENTOBOX.map(({ projectId }) => ({ projectId })),
    )
    expect(
      plan.kind === 'ok'
        ? plan.mods.map((m) => [m.name, 'versionId' in m.source && m.source.versionId])
        : plan,
    ).toEqual([
      ['AOneBlock', 'SO3SQFxw'],
      ['BentoBox', 'Wm9asg4I'],
      ['BSkyBlock', '3kLVOQCM'],
      ['Level', '55hL6XOg'],
      ['Warps', '4yAHWSTz'],
    ])
  }, 30_000)
})
