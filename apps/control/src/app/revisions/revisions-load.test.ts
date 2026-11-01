// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Revision requests preserve persisted choices across no-ops, stale requests, waiting and pack changes. */
import { afterAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

// Cases create separate servers; the file owns the database and its final cleanup.
let harness: ReturnType<typeof startHarness> | undefined
afterAll(async () => {
  await harness?.then(
    (h) => h.close(),
    () => undefined,
  )
})

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
  const resized = (await desired()).id
  await h.app.revisions.resize(owner, server.id, '3g', crypto.randomUUID())
  expect((await desired()).id).toBe(resized)
  await h.app.revisions.rollback(owner, server.id, first.id, crypto.randomUUID())
  expect(await desired()).toMatchObject({
    reason: 'rollback',
    basedOnRevisionId: first.id,
    settings: { ...first.settings, onlineMode: true },
  })
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

describe.skipIf(!hasDatabase)('revision service requests through a real composition', () => {
  test('preserves each choice, no-op and waiting change across the revision APIs', changes, 60 * SECOND_MS)
  test('pins pack updates and rejects incompatible or unrelated changes', packs, 60 * SECOND_MS)
})
