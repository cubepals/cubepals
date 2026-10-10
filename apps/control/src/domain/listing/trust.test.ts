// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PinnedMod } from '../mods/artifact.ts'
import type { ProjectState, VersionState } from '../mods/catalog.ts'
import { type CatalogView, copying, eligibility, trust } from './trust.ts'

const mod = (name: string, projectId: string, versionId: string): PinnedMod => ({
  source: { catalog: 'modrinth', projectId, versionId },
  name,
  versionLabel: '1',
  artifact: {
    ref: { kind: 'remote', url: 'https://cdn.test/x.jar' },
    sha512: 'a'.repeat(128),
    sizeBytes: 1,
    fileName: 'x.jar',
  },
  environment: 'server',
  loaders: ['fabric'],
  gameVersions: ['26.3'],
  origin: 'user',
  requiredBy: [],
})
const upload: PinnedMod = { ...mod('Own mod', 'x', 'y'), source: { catalog: 'upload', uploadId: 'u-1' } }

const catalog = (
  allowlisted: string[],
  projects: Record<string, ProjectState>,
  versions: Record<string, VersionState>,
): CatalogView => ({
  allowlisted: new Set(allowlisted.map((p) => `modrinth:${p}`)),
  project: (_catalog, projectId) => projects[projectId] ?? null,
  version: (_catalog, versionId) => versions[versionId] ?? null,
})

describe('trust', () => {
  const lithium = mod('Lithium', 'lithium', 'l-1')
  const sodium = mod('Sodium', 'sodium', 's-1')

  test('a modpack is never trusted: its mods are the pack author\u2019s, not ones Blockly vouched for', () => {
    const pack = {
      catalog: 'modrinth',
      projectId: 'cab',
      versionId: 'cab-2',
      name: 'Create: Above and Beyond',
      versionLabel: '2.0',
      artifact: {
        ref: { kind: 'remote' as const, url: 'https://cdn.test/cab.mrpack' },
        sha512: 'f'.repeat(128),
        sizeBytes: 1024,
        fileName: 'cab.mrpack',
      },
      page: 'https://modrinth.com/modpack/cab',
      environment: 'both' as const,
      icon: null,
    }
    // Even with no mods of its own, which would otherwise read as plain vanilla.
    expect(trust([], catalog([], {}, {}), pack)).toEqual({
      kind: 'untrusted',
      mods: [{ name: 'Create: Above and Beyond', reason: 'modpack' }],
    })
  })

  test('no mods is vanilla; allowlisted and published everywhere is catalog-trusted', () => {
    const cache = catalog(
      ['lithium', 'sodium'],
      { lithium: 'approved', sodium: 'archived' },
      { 'l-1': 'listed', 's-1': 'unlisted' },
    )
    expect(trust([], cache)).toEqual({ kind: 'vanilla' })
    expect(trust([lithium, sodium], cache)).toEqual({ kind: 'catalog_trusted' })
  })

  test('the allowlist is necessary, and the catalog can take trust back', () => {
    const cache = catalog(
      ['lithium', 'sodium', 'gone'],
      { lithium: 'withheld', sodium: 'approved', gone: 'approved' },
      { 'l-1': 'listed', 's-1': 'absent' },
    )
    const unknown = mod('Unseen', 'gone', 'g-1')
    const stranger = mod('Stranger', 'stranger', 'x-1')
    expect(trust([lithium, sodium, unknown, stranger, upload], cache)).toEqual({
      kind: 'untrusted',
      mods: [
        { name: 'Lithium', reason: 'project_revoked' },
        { name: 'Sodium', reason: 'version_revoked' },
        { name: 'Unseen', reason: 'unknown' },
        { name: 'Stranger', reason: 'not_allowlisted' },
        { name: 'Own mod', reason: 'upload' },
      ],
    })
  })
})

describe('copying', () => {
  test('only a setup Blockly vouches for is copied, and then only while its owner offers it', () => {
    // Vanilla and vouched-for mods are the owner's to offer or keep.
    expect(copying({ kind: 'vanilla' }, true)).toEqual({ allowed: true, locked: false })
    expect(copying({ kind: 'catalog_trusted' }, true)).toEqual({ allowed: true, locked: false })
    expect(copying({ kind: 'catalog_trusted' }, false)).toEqual({ allowed: false, locked: false })
    // Anything Blockly can't vouch for keeps copying off, whatever the owner wants.
    for (const reason of ['upload', 'not_allowlisted', 'project_revoked', 'modpack'] as const)
      expect(copying({ kind: 'untrusted', mods: [{ name: 'X', reason }] }, true)).toEqual({
        allowed: false,
        locked: true,
      })
  })
})

describe('eligibility', () => {
  const active = { status: 'active' as const, restrictions: {} }
  test('a vanilla server of an account in good standing on a plan that lists is eligible', () => {
    expect(
      eligibility({
        trust: { kind: 'vanilla' },
        standing: active,
        entitlements: { mayListPublicly: true },
        deleted: false,
      }),
    ).toEqual({ eligible: true, reasons: [] })
  })

  test('every reason is kept, so the owner sees them all at once', () => {
    expect(
      eligibility({
        trust: { kind: 'untrusted', mods: [{ name: 'Own mod', reason: 'upload' }] },
        standing: { status: 'suspended', restrictions: { publicListing: true } },
        entitlements: { mayListPublicly: false },
        deleted: true,
      }),
    ).toEqual({
      eligible: false,
      reasons: [
        { code: 'server_deleted' },
        { code: 'untrusted_mods', detail: 'Own mod: upload' },
        { code: 'account_not_active' },
        { code: 'restricted' },
        { code: 'not_entitled' },
      ],
    })
    expect(
      eligibility({ trust: null, standing: active, entitlements: { mayListPublicly: true }, deleted: false })
        .reasons,
    ).toEqual([{ code: 'not_running_yet' }])
  })
})
