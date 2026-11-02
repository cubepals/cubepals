// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Exact-version exclusions and explicit client declarations remain authoritative during loader-scoped resolution. */
import { expect, test } from 'bun:test'
import type { CatalogProject, CatalogVersion } from './catalog.ts'
import type { CatalogData, ResolveRequest } from './resolve.ts'
import { resolve } from './resolve.ts'

const request: ResolveRequest = {
  catalog: 'modrinth',
  target: { gameVersion: '26.3', loaders: ['fabric'] },
  wanted: [{ projectId: 'first' }, { projectId: 'second' }],
  current: [],
  upgrade: new Set(),
  environment: () => 'server',
}
const project = (id: string): CatalogProject => ({
  projectId: id,
  slug: id,
  name: id,
  summary: '',
  iconUrl: null,
  environments: ['server_only'],
  downloads: 0,
  state: 'approved',
})
const version = (id: string): CatalogVersion => ({
  projectId: id,
  versionId: `${id}-version`,
  versionLabel: '1',
  channel: 'release',
  state: 'listed',
  environment: 'server_only',
  loaders: ['fabric'],
  gameVersions: ['26.3'],
  publishedAt: new Date(),
  file: {
    url: `https://example.test/${id}.jar`,
    sha512: id.padEnd(128, '0'),
    sizeBytes: 1,
    fileName: `${id}.jar`,
  },
  dependencies: [],
})
function data(): CatalogData {
  const first = {
    ...version('first'),
    dependencies: [{ projectId: null, versionId: 'second-version', kind: 'incompatible' as const }],
  }
  const second = version('second')
  return {
    projects: new Map(['first', 'second'].map((id) => [id, project(id)])),
    fitting: new Map([
      ['first', [first]],
      ['second', [second]],
    ]),
    versions: new Map([
      [first.versionId, first],
      [second.versionId, second],
    ]),
  }
}

test('version-only exclusions identify their project and never invent one for a missing version', () => {
  const known = data()
  expect(resolve(request, known)).toMatchObject({
    kind: 'conflicts',
    conflicts: [{ kind: 'incompatible', mod: 'first', with: 'second' }],
  })
  const absent = { ...known, versions: new Map(known.versions).set('second-version', null) }
  expect(resolve(request, absent).kind).toBe('resolved')
  const unknown = { ...known, versions: new Map(known.versions) }
  unknown.versions.delete('second-version')
  expect(resolve(request, unknown)).toMatchObject({ kind: 'need', versions: ['second-version'] })
})

test('a selected loader explicitly declaring a client entry refuses a server catalog label', () => {
  const known = data()
  known.needs = new Map([
    [
      'first-version',
      {
        java: null,
        api: null,
        native: {
          fabric: {
            ids: ['first'],
            depends: [],
            carriesJars: false,
            complete: true,
            version: '1',
            requirements: [],
            environment: 'client',
          },
        },
      },
    ],
  ])
  expect(resolve({ ...request, wanted: [{ projectId: 'first' }] }, known)).toMatchObject({
    kind: 'conflicts',
    conflicts: [{ kind: 'client_only', mod: 'first' }],
  })
})
