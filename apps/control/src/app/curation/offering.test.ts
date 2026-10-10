/**
 * What new servers are offered by name is read on every create page and every pick of a pack, and
 * changes only when a release is published or withdrawn: read lean, kept briefly, and forgotten
 * the moment a release moves.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { type CuratedFactsJson, type PinnedModpackJson, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'
import type { CuratedPack } from './packs.ts'
import { loadPublished } from './persistence.ts'
import { OFFERED_KEPT_MS } from './service.ts'

describe.skipIf(!hasDatabase)('the packs new servers are offered', () => {
  let h: Harness
  const admin: Actor = { kind: 'admin', userId: 'curator' }
  const pack: CuratedPack = {
    key: 'kept',
    name: 'Kept pack',
    blurb: 'A pack to offer.',
    authors: 'Someone',
    source: { catalog: 'modrinth', projectId: 'kept-project' },
    distribution: 'mirror',
    readings: [],
    permissions: [],
    authored: [],
    review: 'docs/reviews/kept.md',
    releases: [
      { version: '3.0', versionId: 'kept-3', sha512: 'c'.repeat(128), sizeBytes: 1 },
      { version: '2.0', versionId: 'kept-2', sha512: 'b'.repeat(128), sizeBytes: 1 },
      { version: '1.0', versionId: 'kept-1', sha512: 'a'.repeat(128), sizeBytes: 1 },
    ],
  }

  const pinned = (version: string): PinnedModpackJson & { icon: string } => ({
    catalog: 'modrinth',
    projectId: 'kept-project',
    versionId: `kept-${version}`,
    name: 'Kept pack',
    versionLabel: version,
    artifact: {
      ref: { kind: 'stored', key: `kept-${version}` },
      sha512: 'a'.repeat(128),
      sizeBytes: 1,
      fileName: 'kept.mrpack',
    },
    page: null,
    icon: 'https://cdn.example.test/kept.png',
  })
  const facts: CuratedFactsJson = {
    gameVersion: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.0',
    tier: 'm',
    playersNeedIt: true,
    mods: 1,
    jarBytes: 1,
    notes: [],
    upstream: null,
    checked: { files: 1, bytes: 1, hosts: [] },
    code: [],
    licences: [{ name: 'Mod', project: null, licence: 'MIT', kind: 'open' }],
    obligations: [],
    mirrorBlockers: [],
  }
  const stateOf = (version: string, state: 'published') =>
    h.db
      .update(schema.curatedReleases)
      .set({ state })
      .where(and(eq(schema.curatedReleases.packKey, 'kept'), eq(schema.curatedReleases.version, version)))
  const offeredVersions = async () =>
    (await h.app.curation.offered()).map(({ pack, release }) => `${pack.key}@${release.version}`)

  beforeAll(async () => {
    h = await startHarness({ curatedPacks: [pack] })
    await h.db.insert(schema.curatedReleases).values([
      {
        packKey: 'kept',
        version: '1.0',
        state: 'published',
        distribution: 'mirror',
        pack: pinned('1.0'),
        facts,
      },
      {
        packKey: 'kept',
        version: '2.0',
        state: 'verified',
        distribution: 'mirror',
        pack: pinned('2.0'),
        facts,
      },
      { packKey: 'kept', version: '3.0', state: 'refused', refusal: 'A file didn’t match.' },
    ])
  }, 30_000)

  afterEach(() => setSystemTime())

  afterAll(async () => {
    await h.close()
  })

  test('only published releases are read, with what offering them needs', async () => {
    const published = await loadPublished(h.db, ['kept', 'nobody'])
    expect(published).toEqual([
      {
        key: 'kept',
        version: '1.0',
        state: 'published',
        pack: { environment: 'both', ...pinned('1.0') },
        facts,
      },
    ])
    expect(await loadPublished(h.db, [])).toEqual([])
    expect(await offeredVersions()).toEqual(['kept@1.0'])
  })

  test('a release this process publishes or withdraws is offered, or not, at once', async () => {
    expect(await offeredVersions()).toEqual(['kept@1.0'])
    await h.app.curation.publish(admin, { key: 'kept', version: '2.0' })
    expect(await offeredVersions()).toEqual(['kept@2.0'])
    await h.app.curation.withdraw(admin, { key: 'kept', version: '2.0' }, 'It crashes on join')
    expect(await offeredVersions()).toEqual(['kept@1.0'])
  })

  test('what is offered is kept a short while, and read again once it is that old', async () => {
    // Well past whatever an earlier read kept, so this one reads.
    const start = Date.now() + 10 * OFFERED_KEPT_MS
    setSystemTime(start)
    expect(await offeredVersions()).toEqual(['kept@1.0'])
    // Another process publishes 2.0: this one goes on offering what it read, for a while.
    await stateOf('2.0', 'published')
    setSystemTime(start + OFFERED_KEPT_MS - 1)
    expect(await offeredVersions()).toEqual(['kept@1.0'])
    setSystemTime(start + OFFERED_KEPT_MS)
    expect(await offeredVersions()).toEqual(['kept@2.0'])
  })
})
