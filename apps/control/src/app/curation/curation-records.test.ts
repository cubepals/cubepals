// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { schema } from '@blockly/db'
import { and, asc, eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { fabricJar, textOf, unzipBytes, utf8, zipBytes } from '../../testing/uploads.ts'
import type { Actor } from '../actor.ts'
import { NotFound } from '../errors.ts'
import type { CuratedPack } from './packs.ts'
import { loadRelease } from './persistence.ts'

// What curation records as it checks and moves releases, in its own words: the audit rows, the
// sentences an admin reads, what a job that gave up leaves, and the admins' summary of a release.
describe.skipIf(!hasDatabase)('what curation records', () => {
  let h: Harness
  const cdn = new Cdn()
  const store = new MemoryStore()
  const review: CuratedPack[] = []
  const admin: Actor = { kind: 'admin', userId: 'curator' }

  beforeAll(async () => {
    await cdn.start()
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null }, curatedPacks: review })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    store.close()
    cdn.close()
  })

  interface Mod {
    id: string
    licence: string
    /** Where the pack's index says to download it from, when not the CDN. */
    url?: string
  }

  /** A pack published on the catalog, each mod published beside it and listed in its index. */
  const publishPack = (key: string, mods: Mod[], licence = 'MIT'): CatalogVersion => {
    const files = mods.map((mod) => {
      const file = cdn.file(`${mod.id}-mod`, fabricJar(mod.id, { depends: { minecraft: '1.21.1' } }))
      h.catalog.publish(
        {
          projectId: `${mod.id}-project`,
          slug: mod.id,
          name: `Mod ${mod.id}`,
          summary: '',
          iconUrl: null,
          environments: ['server_only'],
          downloads: 1,
          licence: mod.licence,
        },
        [
          {
            versionId: `${mod.id}-v1`,
            projectId: `${mod.id}-project`,
            versionLabel: '1.0',
            channel: 'release',
            state: 'listed',
            environment: 'server_only',
            loaders: ['fabric'],
            gameVersions: ['1.21.1'],
            publishedAt: new Date(Date.UTC(2026, 0, 1)),
            file,
            dependencies: [],
          },
        ],
      )
      return { mod, file }
    })
    const pack = cdn.file(
      `${key}-1`,
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1.0',
            name: `Pack ${key}`,
            files: files.map(({ mod, file }) => ({
              path: `mods/${mod.id}.jar`,
              hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
              env: { client: 'required', server: 'required' },
              downloads: [mod.url ?? file.url],
              fileSize: file.sizeBytes,
            })),
            dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
          }),
        ),
        'overrides/config/pack.toml': utf8('release = 1\n'),
      }),
    )
    const version: CatalogVersion = {
      versionId: `${key}-v1`,
      projectId: `${key}-project`,
      versionLabel: '1.0',
      channel: 'release',
      state: 'listed',
      environment: 'client_and_server',
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
      publishedAt: new Date(Date.UTC(2026, 0, 1)),
      file: pack,
      dependencies: [],
    }
    h.catalog.publishModpack(
      {
        projectId: `${key}-project`,
        slug: key,
        name: `Pack ${key}`,
        summary: 'For tests',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 1,
        categories: [],
        licence,
      },
      [version],
    )
    return version
  }

  const reviewed = (key: string, distribution: 'mirror' | 'upstream', version: CatalogVersion) => {
    const entry: CuratedPack = {
      key,
      name: `Pack ${key}`,
      blurb: 'A pack for tests.',
      authors: 'Test authors',
      source: { catalog: 'modrinth', projectId: `${key}-project` },
      distribution,
      readings: [],
      permissions: [],
      authored: [],
      review: `docs/modpack-templates.md#${key}`,
      releases: [
        {
          version: version.versionLabel,
          versionId: version.versionId,
          sha512: version.file.sha512,
          sizeBytes: version.file.sizeBytes,
        },
      ],
    }
    review.push(entry)
    return entry
  }

  const checked = async (key: string) => {
    await h.app.curation.queueDue()
    await h.app.curation.ingest({ key, version: '1.0' })
    return loadRelease(h.db, key, '1.0')
  }

  const audits = (key: string) =>
    h.db
      .select({
        actor: schema.auditLog.actor,
        action: schema.auditLog.action,
        subject: schema.auditLog.subjectId,
        data: schema.auditLog.data,
      })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.subjectType, 'curated_release'), eq(schema.auditLog.subjectId, `${key}@1.0`)),
      )
      .orderBy(asc(schema.auditLog.at))

  const workDirs = async () =>
    (await readdir(tmpdir())).filter((name) => name.startsWith('blockly-curation-'))

  test('every check and every move an admin makes is audited, with what it found or changed', async () => {
    const v1 = publishPack('audited', [{ id: 'a1', licence: 'MIT' }])
    reviewed('audited', 'upstream', v1)
    expect((await checked('audited'))?.state).toBe('verified')
    await h.app.curation.publish(admin, { key: 'audited', version: '1.0' })
    await h.app.curation.withdraw(admin, { key: 'audited', version: '1.0' }, '  It crashes on join  ')
    const withdrawn = await loadRelease(h.db, 'audited', '1.0')
    expect(withdrawn?.withdrawnReason).toBe('It crashes on join')
    expect(withdrawn?.changedBy).toBe('admin:curator')
    const shown = (await h.app.curation.review(admin)).find((p) => p.key === 'audited')
    expect(shown?.releases[0]?.withdrawnReason).toBe('It crashes on join')
    await h.app.curation.publish(admin, { key: 'audited', version: '1.0' })
    expect((await loadRelease(h.db, 'audited', '1.0'))?.withdrawnReason).toBeNull()

    expect(await audits('audited')).toEqual([
      {
        actor: 'system:curation',
        action: 'curation.verified',
        subject: 'audited@1.0',
        data: { distribution: 'upstream', sha512: v1.file.sha512 },
      },
      {
        actor: 'admin:curator',
        action: 'curation.published',
        subject: 'audited@1.0',
        data: { from: 'verified', to: 'published' },
      },
      {
        actor: 'admin:curator',
        action: 'curation.withdrawn',
        subject: 'audited@1.0',
        data: { from: 'published', to: 'withdrawn', reason: 'It crashes on join' },
      },
      {
        actor: 'admin:curator',
        action: 'curation.published',
        subject: 'audited@1.0',
        data: { from: 'withdrawn', to: 'published' },
      },
    ])
  })

  test('a refusal is audited once, a second check of it changes nothing, and checking again is audited', async () => {
    const v1 = publishPack('closed', [{ id: 'c1', licence: 'LicenseRef-All-Rights-Reserved' }])
    reviewed('closed', 'mirror', v1)
    const before = await workDirs()
    const refused = await checked('closed')
    expect(refused?.state).toBe('refused')
    expect(refused?.refusal).toBe(
      'Its licences don’t allow what the review asked for (all rights reserved: Mod c1).',
    )
    expect(refused?.detail).toBe(
      'closed@1.0: [{"name":"Mod c1","licence":"LicenseRef-All-Rights-Reserved","because":"reserved"}]',
    )
    // The same job run again finds it no longer pending, and leaves it as it was.
    await h.app.curation.ingest({ key: 'closed', version: '1.0' })
    expect(await workDirs()).toEqual(before)

    await expect(h.app.curation.withdraw(admin, { key: 'closed', version: '1.0' }, 'no')).rejects.toThrow(
      'A release that is refused can’t be withdrawn.',
    )
    await h.app.curation.retry(admin, { key: 'closed', version: '1.0' })
    const retried = await loadRelease(h.db, 'closed', '1.0')
    expect([retried?.state, retried?.refusal, retried?.detail]).toEqual(['pending', null, null])

    const refusedData = {
      refusal: 'Its licences don’t allow what the review asked for (all rights reserved: Mod c1).',
      detail:
        'closed@1.0: [{"name":"Mod c1","licence":"LicenseRef-All-Rights-Reserved","because":"reserved"}]',
    }
    expect(await audits('closed')).toEqual([
      { actor: 'system:curation', action: 'curation.refused', subject: 'closed@1.0', data: refusedData },
      {
        actor: 'admin:curator',
        action: 'curation.retried',
        subject: 'closed@1.0',
        data: { from: 'refused', to: 'pending' },
      },
    ])
  })

  test('a job that gives up refuses the release in plain words, once', async () => {
    const v1 = publishPack('given-up', [{ id: 'g1', licence: 'MIT' }])
    reviewed('given-up', 'upstream', v1)
    await h.app.curation.queueDue()
    await h.app.curation.ingestGaveUp({ key: 'given-up', version: '1.0' }, 'the host timed out')
    await h.app.curation.ingestGaveUp({ key: 'given-up', version: '1.0' }, 'and again')
    const release = await loadRelease(h.db, 'given-up', '1.0')
    expect([release?.state, release?.refusal, release?.detail, release?.changedBy]).toEqual([
      'refused',
      'Cubepals couldn’t finish checking this release. Try again.',
      'the host timed out',
      'system:curation',
    ])
    expect(await audits('given-up')).toEqual([
      {
        actor: 'system:curation',
        action: 'curation.refused',
        subject: 'given-up@1.0',
        data: {
          refusal: 'Cubepals couldn’t finish checking this release. Try again.',
          detail: 'the host timed out',
        },
      },
    ])
  })

  test('a host that doesn’t answer leaves the release pending for the job to try again, and no work behind', async () => {
    const v1 = publishPack('unanswered', [{ id: 'u1', licence: 'MIT' }])
    reviewed('unanswered', 'upstream', v1)
    cdn.files.delete('/files/u1-mod.jar')
    const before = await workDirs()
    await h.app.curation.queueDue()
    await expect(h.app.curation.ingest({ key: 'unanswered', version: '1.0' })).rejects.toThrow(/answered 404/)
    expect((await loadRelease(h.db, 'unanswered', '1.0'))?.state).toBe('pending')
    expect(await audits('unanswered')).toEqual([])
    expect(await workDirs()).toEqual(before)
  })

  test('a pack that downloads a mod from a site the catalog doesn’t allow is refused, naming the file', async () => {
    const v1 = publishPack('far', [{ id: 'f1', licence: 'MIT', url: 'https://elsewhere.example/f1.jar' }])
    reviewed('far', 'upstream', v1)
    h.catalog.allowDownloadsFrom(['127.0.0.1'])
    try {
      const release = await checked('far')
      expect([release?.state, release?.refusal, release?.detail]).toEqual([
        'refused',
        'It downloads f1.jar from a site Cubepals doesn’t fetch packs from.',
        'far@1.0: https://elsewhere.example/f1.jar',
      ])
    } finally {
      h.catalog.allowDownloadsFrom(null)
    }
  })

  test('Blockly’s copy carries the notices it owes, and the admins see what checking found', async () => {
    const v1 = publishPack('noticed', [
      { id: 'n1', licence: 'LGPL-3.0-only' },
      { id: 'n2', licence: 'MIT' },
    ])
    reviewed('noticed', 'mirror', v1)
    const before = await workDirs()
    const release = await checked('noticed')
    expect(await workDirs()).toEqual(before)
    expect(release?.state).toBe('verified')
    const copy = store.objects.get(`artifacts/${release?.pack?.artifact.sha512}`)
    if (copy === undefined) throw new Error('no copy was kept')
    const entries = unzipBytes(copy)
    expect(Object.keys(entries).sort()).toEqual([
      'blockly-notices.txt',
      'modrinth.index.json',
      'overrides/config/pack.toml',
      'overrides/mods/n1.jar',
      'overrides/mods/n2.jar',
    ])
    expect(textOf(entries['blockly-notices.txt'] as Uint8Array)).toBe(
      [
        'Pack noticed 1.0, by Test authors.',
        'Cubepals made this copy for its own servers, file for file as its authors published them.',
        'Every work in it keeps its own licence, and its authors own it.',
        '',
        '- Pack noticed: MIT.',
        `- Mod n1: LGPL-3.0-only. Source: ${h.catalog.projectPage('n1-project')}`,
        '- Mod n2: MIT.',
        '',
      ].join('\n'),
    )

    // A release that can't be copied keeps what stands in the way, summed up for the admins.
    const v2 = publishPack('blocked', [
      { id: 'b1', licence: 'MPL-2.0' },
      { id: 'b2', licence: 'LicenseRef-All-Rights-Reserved' },
    ])
    reviewed('blocked', 'upstream', v2)
    await checked('blocked')
    const view = (await h.app.curation.review(admin)).find((p) => p.key === 'blocked')
    expect(view).toMatchObject({
      key: 'blocked',
      name: 'Pack blocked',
      authors: 'Test authors',
      distribution: 'upstream',
      review: 'docs/modpack-templates.md#blocked',
      held: null,
    })
    expect(view?.releases).toEqual([
      {
        version: '1.0',
        state: 'verified',
        distribution: 'upstream',
        refusal: null,
        detail: null,
        withdrawnReason: null,
        changedBy: 'system:curation',
        verifiedAt: expect.any(String),
        publishedAt: null,
        withdrawnAt: null,
        facts: {
          gameVersion: '1.21.1',
          loaderLabel: 'Fabric',
          mods: 2,
          checkedFiles: 2,
          hosts: ['127.0.0.1'],
          licences: { open: 1, copyleft: 1, reserved: 1 },
          mirrorBlockers: ['Mod b2 (LicenseRef-All-Rights-Reserved)'],
          code: [],
        },
      },
    ])
  })

  test('a release is offered by name only once it is published, and a pack only while it is reviewed', async () => {
    await expect(h.app.curation.releaseFor('nowhere')).rejects.toThrow(NotFound)
    await expect(h.app.curation.releaseFor('blocked')).rejects.toThrow(
      'Pack blocked isn’t offered right now.',
    )
    await expect(h.app.curation.releaseFor('blocked', '1.0')).rejects.toThrow(
      'Pack blocked 1.0 isn’t offered right now.',
    )
    await expect(h.app.curation.releaseFor('blocked', '9.9')).rejects.toThrow(
      'Pack blocked 9.9 isn’t offered right now.',
    )
    await h.app.curation.publish(admin, { key: 'blocked', version: '1.0' })
    expect((await h.app.curation.releaseFor('blocked', '1.0')).release.version).toBe('1.0')
    expect((await h.app.curation.releaseFor('blocked')).release.version).toBe('1.0')
  })
})
