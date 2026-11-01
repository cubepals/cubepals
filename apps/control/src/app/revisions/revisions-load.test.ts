// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Revision requests preserve persisted choices across no-ops, stale requests, waiting and pack changes. */
import { afterAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { closestTier, memoryMb, playerCapacity } from '../../domain/server/size.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { requestedBy, type UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { acknowledged } from './service.ts'

// Cases create separate servers; the file owns the database and its final cleanup.
let harness: ReturnType<typeof startHarness> | undefined
let acknowledgementFixture: Promise<Awaited<ReturnType<typeof acknowledgementRecords>>> | undefined
let acknowledgementCdn: Cdn | undefined
afterAll(async () => {
  acknowledgementCdn?.close()
  await harness?.then(
    (h) => h.close(),
    () => undefined,
  )
})

async function audit(
  h: Harness,
  owner: UserActor,
  serverId: string,
  action: string,
  data: Record<string, unknown>,
) {
  const [row] = await h.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, serverId), eq(schema.auditLog.action, action)))
    .orderBy(desc(schema.auditLog.at))
    .limit(1)
  expect(row).toMatchObject({
    actor: requestedBy(owner),
    action,
    subjectType: 'server',
    subjectId: serverId,
    data,
  })
}

async function membership(
  h: Harness,
  owner: UserActor,
  serverId: string,
  desired: () => ReturnType<typeof loadRevision>,
) {
  await h.app.revisions.changeAuthentication(owner, serverId, false, crypto.randomUUID())
  expect((await desired()).settings.onlineMode).toBe(false)
  const offline = (await desired()).id
  await h.app.revisions.changeAuthentication(owner, serverId, false, crypto.randomUUID())
  expect((await desired()).id).toBe(offline)
  await h.app.revisions.changeAuthentication(owner, serverId, true, crypto.randomUUID())
  expect((await desired()).settings.onlineMode).toBe(true)
  await h.app.revisions.changeOtherVersions(owner, serverId, 'off', crypto.randomUUID())
  expect((await desired()).settings.otherVersions).toBe('off')
  const closed = (await desired()).id
  await h.app.revisions.changeOtherVersions(owner, serverId, 'off', crypto.randomUUID())
  expect((await desired()).id).toBe(closed)
  await h.app.revisions.changeOtherVersions(owner, serverId, 'on', crypto.randomUUID())
  expect((await desired()).settings.otherVersions).toBe('on')
  await h.app.revisions.changeBedrock(owner, serverId, false, crypto.randomUUID())
  expect((await desired()).settings.bedrock).toBe(false)
  await h.app.mods.changeVersion(
    owner,
    serverId,
    { gameVersion: '26.2', loader: 'vanilla', onPaper: false },
    [],
    crypto.randomUUID(),
  )
  expect((await desired()).loaderVersion).toBeNull()
  await h.app.revisions.changeBedrock(owner, serverId, true, crypto.randomUUID())
  expect((await desired()).loaderVersion).not.toBeNull()
  expect((await desired()).settings.bedrock).toBe(true)
  const bedrock = (await desired()).id
  await h.app.revisions.changeBedrock(owner, serverId, true, crypto.randomUUID())
  expect((await desired()).id).toBe(bedrock)
  await audit(h, owner, serverId, 'server.authentication_changed', { onlineMode: true })
  await audit(h, owner, serverId, 'server.other_versions_changed', { otherVersions: 'on' })
  await audit(h, owner, serverId, 'server.bedrock_changed', { bedrock: true, onPaper: true })
}

async function waitsForPlayers(h: Harness, owner: UserActor, serverId: string) {
  await h.app.servers.start(owner, serverId, crypto.randomUUID())
  await h.until(serverId, 'running', 3 * SECOND_MS)
  await h.settled(serverId, 3 * SECOND_MS)
  const player = { uuid: crypto.randomUUID(), name: 'Alex' }
  h.minecraft.join(serverId, player)
  await h.app.schedules.presenceSync()
  await h.app.revisions.changeSettings(
    owner,
    serverId,
    {
      ...(await loadRevision(h.db, (await h.server(serverId)).desiredRevisionId)).settings,
      spawnProtection: 4,
    },
    crypto.randomUUID(),
    { when: 'empty' },
  )
  expect((await h.app.queries.get(owner, serverId)).waiting).not.toBeNull()
  expect((await h.server(serverId)).lifecycle.status).toBe('running')
  h.minecraft.leave(serverId, player.uuid)
  await h.app.schedules.presenceSync()
  await h.app.schedules.drift()
  await h.settled(serverId, 3 * SECOND_MS)
  expect((await h.app.queries.get(owner, serverId)).waiting).toBeNull()
  expect(await h.minecraft.file(serverId, 'server.properties')).toContain('spawn-protection=4')
}

async function changes() {
  harness ??= startHarness()
  const h = await harness
  const owner = await h.user('Steve', 'plus')
  const server = await h.create(owner, { gameVersion: '26.2' })
  await h.until(server.id, 'running', 3 * SECOND_MS)
  await h.settled(server.id, 3 * SECOND_MS)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID())
  await h.until(server.id, 'stopped', 3 * SECOND_MS)
  await h.settled(server.id, 3 * SECOND_MS)
  const desired = async () => loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
  const first = await desired()
  const change = async (patch: Partial<typeof first.settings>, options = {}) =>
    h.app.revisions.changeSettings(
      owner,
      server.id,
      { ...(await desired()).settings, ...patch },
      crypto.randomUUID(),
      options,
    )
  await change({ difficulty: 'hard', pvp: false })
  expect((await desired()).settings).toMatchObject({ difficulty: 'hard', pvp: false })
  await audit(h, owner, server.id, 'server.settings_changed', {
    changes: [
      { field: 'pvp', from: first.settings.pvp, to: false },
      { field: 'difficulty', from: first.settings.difficulty, to: 'hard' },
    ],
  })
  const saved = (await desired()).id
  await change({ difficulty: 'hard', pvp: false })
  expect((await desired()).id).toBe(saved)
  await expect(change({ viewDistance: 99 })).rejects.toThrow(/View distance/)
  await expect(
    h.app.revisions.changeSettings(
      owner,
      server.id,
      { ...(await desired()).settings, difficulty: 'easy' },
      crypto.randomUUID(),
      { version: server.version },
    ),
  ).rejects.toThrow(/changed since/)
  const stranger = await h.user()
  await expect(
    h.app.revisions.changeSettings(stranger, server.id, (await desired()).settings, crypto.randomUUID()),
  ).rejects.toThrow()
  await membership(h, owner, server.id, desired)
  await h.app.revisions.resize(owner, server.id, '4g', crypto.randomUUID())
  expect((await h.server(server.id)).memoryTier).toBe('4g')
  await change({ maxPlayers: 10 })
  await h.app.revisions.resize(owner, server.id, '3g', crypto.randomUUID())
  expect((await desired()).settings.maxPlayers).toBe(
    (await h.app.queries.settingsOptions(owner, server.id)).bounds.maxPlayers,
  )
  await audit(h, owner, server.id, 'server.resized', { from: '4g', to: '3g' })
  const resized = (await desired()).id
  await h.app.revisions.resize(owner, server.id, '3g', crypto.randomUUID())
  expect((await desired()).id).toBe(resized)
  await h.app.revisions.rollback(owner, server.id, first.id, crypto.randomUUID())
  expect(await desired()).toMatchObject({
    reason: 'rollback',
    basedOnRevisionId: first.id,
    settings: { ...first.settings, onlineMode: true },
  })
  await audit(h, owner, server.id, 'server.rolled_back', { to: first.number, changes: expect.any(Array) })
  await expect(
    h.app.revisions.rollback(owner, server.id, crypto.randomUUID(), crypto.randomUUID()),
  ).rejects.toThrow(/Revision/)
  const current = await desired()
  await h.app.revisions.changeMods(
    owner,
    server.id,
    { basedOn: current.id, mods: current.mods },
    crypto.randomUUID(),
  )
  expect((await desired()).id).toBe(current.id)
  await expect(
    h.app.revisions.changeMods(
      owner,
      server.id,
      { basedOn: first.id, mods: first.mods },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow(/changed/)
  await h.app.mods.changeVersion(
    owner,
    server.id,
    { gameVersion: '26.3', loader: 'vanilla' },
    [],
    crypto.randomUUID(),
  )
  expect((await desired()).gameVersion).toBe('26.3')
  const newer = (await desired()).id
  await h.app.mods.changeVersion(
    owner,
    server.id,
    { gameVersion: '26.3', loader: 'vanilla' },
    [],
    crypto.randomUUID(),
  )
  expect((await desired()).id).toBe(newer)
  await expect(
    h.app.mods.changeVersion(
      owner,
      server.id,
      { gameVersion: '26.1', loader: 'vanilla' },
      [],
      crypto.randomUUID(),
    ),
  ).rejects.toThrow()
  expect((await h.server(server.id)).lifecycle.status).toBe('stopped')
  await waitsForPlayers(h, owner, server.id)
}

function catalogFixture(h: Harness, cdn: Cdn) {
  const versions: Parameters<typeof h.catalog.publishModpack>[1] = []
  const publish = (number: number, gameVersion = '26.2') => {
    versions.unshift({
      versionId: `pack-${number}`,
      projectId: 'probe-pack',
      versionLabel: `${number}.0`,
      channel: 'release',
      state: 'listed',
      environment: 'client_and_server',
      loaders: ['fabric'],
      gameVersions: [gameVersion],
      publishedAt: new Date(Date.UTC(2026, 0, number)),
      file: cdn.file(
        `pack-${number}`,
        zipBytes({
          'modrinth.index.json': utf8(
            JSON.stringify({
              formatVersion: 1,
              game: 'minecraft',
              versionId: `${number}.0`,
              name: 'Probe Pack',
              files: [],
              dependencies: { minecraft: gameVersion, 'fabric-loader': '0.16.14' },
            }),
          ),
        }),
      ),
      dependencies: [],
    })
    h.catalog.publishModpack(
      {
        projectId: 'probe-pack',
        slug: 'probe-pack',
        name: 'Probe Pack',
        summary: 'A pack for revision tests',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 1,
        categories: [],
      },
      [...versions],
    )
  }
  return publish
}

async function packs() {
  const cdn = new Cdn()
  await cdn.start()
  harness ??= startHarness()
  const h = await harness
  try {
    const publish = catalogFixture(h, cdn)
    publish(1)
    const owner = await h.user('Alex', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: 'probe-pack' } })
    await h.until(server.id, 'running', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    await h.app.servers.stop(owner, server.id, crypto.randomUUID())
    await h.until(server.id, 'stopped', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    const desired = async () => loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    const first = await desired()
    await h.app.packChanges.change(
      owner,
      server.id,
      { kind: 'catalog', versionId: 'pack-1' },
      crypto.randomUUID(),
    )
    expect((await desired()).id).toBe(first.id)
    publish(2)
    await h.app.packChanges.change(
      owner,
      server.id,
      { kind: 'catalog', versionId: 'pack-2' },
      crypto.randomUUID(),
    )
    expect((await desired()).modpack).toMatchObject({ versionLabel: '2.0' })
    expect((await desired()).reason).toBe('mods_changed')
    await audit(h, owner, server.id, 'server.pack_changed', { changes: expect.any(Array) })
    publish(3, '1.21.1')
    await expect(
      h.app.packChanges.change(
        owner,
        server.id,
        { kind: 'catalog', versionId: 'pack-3' },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/older version/)
    const current = await desired()
    await expect(
      h.app.revisions.changeMods(
        owner,
        server.id,
        { basedOn: current.id, mods: current.mods },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/pack/)
    await expect(
      h.app.revisions.changeOtherVersions(owner, server.id, 'on', crypto.randomUUID()),
    ).rejects.toThrow(/Paper/)
    await expect(h.app.revisions.changeBedrock(owner, server.id, true, crypto.randomUUID())).rejects.toThrow(
      /without mods/,
    )
    const plainOwner = await h.user('Sam', 'plus')
    const plain = await h.create(plainOwner)
    await h.until(plain.id, 'running', 3 * SECOND_MS)
    await h.settled(plain.id, 3 * SECOND_MS)
    const pinned = await h.app.setups.pinnedPack('probe-pack', 'pack-2')
    await expect(
      h.app.revisions.changePack(
        plainOwner,
        plain.id,
        {
          pack: pinned.pinned,
          gameVersion: pinned.gameVersion,
          loader: pinned.loader,
          loaderVersion: pinned.loaderVersion,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/play a modpack/)
  } finally {
    cdn.close()
  }
}

async function acknowledgementRecords() {
  harness ??= startHarness()
  const h = await harness
  const owner = await h.user('Alex', 'plus')
  const server = await h.create(owner, { loader: 'fabric' })
  await h.until(server.id, 'running', 3 * SECOND_MS)
  await h.settled(server.id, 3 * SECOND_MS)
  acknowledgementCdn = new Cdn()
  await acknowledgementCdn.start()
  return {
    h,
    revision: await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId),
    cdn: acknowledgementCdn,
  }
}
async function revokedAcknowledgement(mode: 'single' | 'plural' | 'accept' | 'kept' | 'mixed' | 'removed') {
  acknowledgementFixture ??= acknowledgementRecords()
  const { h, revision, cdn } = await acknowledgementFixture
  const suffix = crypto.randomUUID()
  const first = cdn.publish(`Amber-${suffix}`)
  const second = cdn.publish(`Birch-${suffix}`)
  const removed = cdn.publish(`Old-${suffix}`)
  const mods = mode === 'single' ? [first] : [first, second]
  for (const mod of mods) {
    if (!('projectId' in mod.source)) throw new Error('The CDN fixture must publish a catalog mod')
    await h.db.insert(schema.catalogProjects).values({
      catalog: mod.source.catalog,
      projectId: mod.source.projectId,
      state: 'withheld',
      fetchedAt: new Date(),
      stateChangedAt: new Date(),
    })
  }
  const kept =
    mode === 'kept' || mode === 'removed'
      ? mods.map((mod) => mod.artifact.sha512)
      : mode === 'mixed'
        ? [first.artifact.sha512]
        : []
  const draft = { ...revision, mods, acknowledgedRevoked: [...kept, removed.artifact.sha512] }
  const call = () =>
    h.db.transaction((tx) =>
      acknowledged(tx, draft, { acknowledgeRevoked: mode === 'accept' || mode === 'mixed' }),
    )
  if (mode === 'single' || mode === 'plural') {
    const names = mods.map((mod) => mod.name).join(', ')
    const expected =
      mode === 'single'
        ? `${names} was taken down where it was published. That can be the author tidying up or a removal for malware; run it only if you trust it.`
        : `${names} were taken down where they were published. That can be the author tidying up or a removal for malware; run them only if you trust them.`
    await expect(call()).rejects.toThrow(expected)
  } else {
    expect(await call()).toEqual(mods.map((mod) => mod.artifact.sha512))
  }
  if (mode === 'removed') {
    expect(await h.db.transaction((tx) => acknowledged(tx, { ...draft, mods: [second] }, {}))).toEqual([
      second.artifact.sha512,
    ])
  }
}

async function downgradedSize() {
  harness ??= startHarness()
  const h = await harness
  const owner = await h.user('Steve', 'plus')
  const server = await h.create(owner)
  await h.until(server.id, 'running', 3 * SECOND_MS)
  await h.settled(server.id, 3 * SECOND_MS)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID())
  await h.until(server.id, 'stopped', 3 * SECOND_MS)
  await h.settled(server.id, 3 * SECOND_MS)
  const largest = [...entitlementsFor('plus').allowedMemoryTiers].sort((a, b) => memoryMb(b) - memoryMb(a))[0]
  if (!largest) throw new Error('The plan fixture must offer a server size')
  await h.app.revisions.resize(owner, server.id, largest, crypto.randomUUID())
  let desired = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
  await h.app.revisions.changeSettings(
    owner,
    server.id,
    { ...desired.settings, maxPlayers: playerCapacity(largest) },
    crypto.randomUUID(),
  )
  desired = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
  await h.db
    .update(schema.accountStanding)
    .set({ plan: 'free' })
    .where(eq(schema.accountStanding.userId, owner.userId))
  const moved = closestTier(largest, entitlementsFor('free').allowedMemoryTiers)
  if (moved === null) throw new Error('The Free fixture must offer a replacement size')
  const capacity = playerCapacity(moved)
  const caps = entitlementsFor('free').settingCaps
  if (!caps) throw new Error('The Free fixture must have its real setting caps')
  expect(largest).not.toBe(moved)
  const difficulty = desired.settings.difficulty === 'hard' ? 'easy' : 'hard'
  await expect(
    h.app.revisions.changeSettings(
      owner,
      server.id,
      { ...desired.settings, difficulty },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow(/servers hold up to/)
  expect((await h.server(server.id)).desiredRevisionId).toBe(desired.id)
  expect((await h.server(server.id)).memoryTier).toBe(largest)
  await h.app.revisions.changeSettings(
    owner,
    server.id,
    {
      ...desired.settings,
      difficulty,
      maxPlayers: Math.min(capacity, caps.maxPlayers),
      viewDistance: caps.viewDistance,
      simulationDistance: caps.simulationDistance,
    },
    crypto.randomUUID(),
  )
  expect((await h.server(server.id)).memoryTier).toBe(moved)
  expect((await h.server(server.id)).lifecycle.status).toBe('stopped')
  await audit(h, owner, server.id, 'server.settings_changed', {
    sizeMovedByPlan: { from: largest, to: moved },
  })
}

describe.skipIf(!hasDatabase)('revision service requests through a real composition', () => {
  test('moves an obsolete plan size only after the player limit fits', downgradedSize, 30 * SECOND_MS)
  for (const mode of ['single', 'plural', 'accept', 'kept', 'mixed', 'removed'] as const)
    test(
      `revoked mod acknowledgements preserve the ${mode} owner choice`,
      () => revokedAcknowledgement(mode),
      30 * SECOND_MS,
    )
  test('preserves each choice, no-op and waiting change across the revision APIs', changes, 60 * SECOND_MS)
  test('pins pack updates and rejects incompatible or unrelated changes', packs, 60 * SECOND_MS)
})
