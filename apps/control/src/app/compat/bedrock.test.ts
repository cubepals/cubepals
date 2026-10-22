// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bedrock players on a Paper server: Floodgate, the key it shares with the edge and chat signing
 * off arrive with the server's start, by default, and go when the owner turns them off.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import {
  bedrockAvailable,
  FLOODGATE,
  FLOODGATE_KEY_ENV,
  GEYSER_JAVA_VERSION,
} from '../../minecraft/bedrock.ts'
import { VIABACKWARDS, VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ArtifactLinks } from '../artifacts/links.ts'
import { singleKey } from '../secrets.ts'
import { loadRevision } from '../servers/persistence.ts'
import { RuntimeSpecs } from '../servers/specs.ts'

let h: Harness
const geyser = new FakeGeyserMc()
/** A key for tests: 16 bytes as base64, nothing a deployment uses. */
const TEST_FLOODGATE_KEY = Buffer.alloc(16, 7).toString('base64')
const cdn = new Cdn()

const via = (projectId: string, name: string) =>
  h.catalog.publish(
    {
      projectId,
      slug: projectId,
      name,
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    [
      {
        versionId: `${projectId}-1`,
        projectId,
        versionLabel: '5.0',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['paper', 'spigot'],
        gameVersions: offeredVersions().map((offered) => offered.id),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file: cdn.file(`${projectId}-1`),
        dependencies: [],
      },
    ],
  )

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness({
    capabilities: { archives: null, billing: null, bedrock: { floodgateKey: TEST_FLOODGATE_KEY, geyser } },
  })
  via(VIAVERSION, 'ViaVersion')
  via(VIABACKWARDS, 'ViaBackwards')
  const file = cdn.file('floodgate-spigot')
  geyser.floodgate = { version: '2.2.5', build: 141, ...file }
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

const smooth = async (name: string) => {
  const owner = await h.user(name)
  const server = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  return { owner, id: server.id }
}

const keyFile = (id: string) => `${h.runtime.machine(id)?.dir ?? ''}/plugins/floodgate/key.pem`
const jarsOf = async (id: string) => {
  const { spec } = await h.app.specs.desired(h.db, await h.server(id))
  return { spec, jars: (spec.env.BLOCKLY_JARS ?? '').split('\n').filter(Boolean) }
}

describe.skipIf(!hasDatabase)('Bedrock players on a Paper server', () => {
  test('a Paper server gets Floodgate, its key and chat unsigned, and the owner’s plugins stay none', async () => {
    const { owner, id } = await smooth('Briar')
    const server = await h.server(id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.mods).toEqual([])
    expect(revision.settings.bedrock).toBeUndefined()
    const { spec, jars } = await jarsOf(id)
    expect(jars.some((line) => line.includes(FLOODGATE))).toBe(true)
    expect(jars.some((line) => line.includes(VIAVERSION))).toBe(true)
    expect(spec.env.ENFORCE_SECURE_PROFILE).toBe('FALSE')
    // The key travels as a secret, never in the environment the drift digest and logs see.
    expect(spec.secrets[FLOODGATE_KEY_ENV]).toBe(TEST_FLOODGATE_KEY)
    expect(JSON.stringify(spec.env)).not.toContain(TEST_FLOODGATE_KEY)
    // On the disk as it started: the 16 bytes the key stands for.
    expect(readFileSync(keyFile(id))).toEqual(Buffer.from(TEST_FLOODGATE_KEY, 'base64'))
    expect((await h.app.queries.get(owner, id)).bedrock).toEqual({
      on: true,
      needsOtherVersions: false,
      moves: false,
    })
  }, 60_000)

  test('turning it off takes Floodgate and the key away at the next start, and on puts them back', async () => {
    const { owner, id } = await smooth('Cedar')
    await h.app.revisions.changeBedrock(owner, id, false, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const { spec, jars } = await jarsOf(id)
    expect(jars.some((line) => line.includes(FLOODGATE))).toBe(false)
    expect(spec.env.ENFORCE_SECURE_PROFILE).toBe('TRUE')
    expect(spec.secrets[FLOODGATE_KEY_ENV]).toBeUndefined()
    expect(existsSync(keyFile(id))).toBe(false)
    expect((await h.app.queries.get(owner, id)).bedrock).toEqual({
      on: false,
      needsOtherVersions: false,
      moves: false,
    })

    await h.app.revisions.changeBedrock(owner, id, true, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(existsSync(keyFile(id))).toBe(true)
  }, 90_000)

  test('a server that lets in only its own version gets no Via plugin for Bedrock, and says why', async () => {
    const { owner, id } = await smooth('Dune')
    await h.app.revisions.changeOtherVersions(owner, id, 'off', randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const { jars, spec } = await jarsOf(id)
    expect(jars).toEqual([])
    expect(spec.secrets[FLOODGATE_KEY_ENV]).toBeUndefined()
    expect(existsSync(keyFile(id))).toBe(false)
    expect((await h.app.queries.get(owner, id)).bedrock).toEqual({
      on: true,
      needsOtherVersions: true,
      moves: false,
    })
    // Its choice is kept: letting other versions in again brings Bedrock back at the next start.
    await h.app.revisions.changeOtherVersions(owner, id, 'on', randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(existsSync(keyFile(id))).toBe(true)
  }, 120_000)

  test('the release Geyser speaks needs no Via plugin, so other versions off leaves Bedrock available', () => {
    expect(bedrockAvailable(GEYSER_JAVA_VERSION, true)).toBe(true)
    expect(bedrockAvailable('26.2', true)).toBe(false)
    expect(bedrockAvailable('26.2', false)).toBe(true)
  })

  test('a deploy that adds Bedrock to a running server is no drift: only its next start carries it', async () => {
    const { id } = await smooth('Heath')
    const server = await h.server(id)
    const ring = singleKey('test-runtime-secrets-key-0123456789')
    const before = new RuntimeSpecs(ring, new ArtifactLinks(h.artifactsUrl, ring), h.app.specs.brandPack)
    const without = await before.desired(h.db, server)
    const withBedrock = await h.app.specs.desired(h.db, server)
    expect(withBedrock.digest).not.toBe(without.digest)
    expect(withBedrock.driftDigest).toBe(without.driftDigest)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('Bedrock and who is on the server', () => {
  test('with players on, the switch is saved and waits for the next start; with none, it applies', async () => {
    const { owner, id } = await smooth('Ivy')
    const player = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, player)
    await h.app.schedules.presenceSync()
    await h.app.revisions.changeBedrock(owner, id, false, randomUUID())
    const saved = await h.server(id)
    expect(saved.lifecycle.status).toBe('running')
    expect(existsSync(keyFile(id))).toBe(true)
    expect((await loadRevision(h.db, saved.desiredRevisionId)).settings.bedrock).toBe(false)
    // Nothing restarted it; the next start runs the saved choice.
    h.minecraft.leave(id, player.uuid)
    await h.app.schedules.presenceSync()
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(existsSync(keyFile(id))).toBe(false)
  }, 120_000)

  test('a Free account’s Paper server has Bedrock: its plugins are Cubepals’, not counted by the plan', async () => {
    const owner = await h.user('Fable')
    expect((await h.app.accountQueries.overview(owner)).plan.key).toBe('free')
    // Free runs plain Paper only; one that carries plugins needs Plus.
    const { templates } = await h.app.queries.createOptions(owner)
    expect(templates.find((template) => template.key === 'smooth')?.fits.allowed).toBe(true)
    const server = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const revision = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    expect(revision.mods).toEqual([])
    const { jars } = await jarsOf(server.id)
    expect(jars.some((line) => line.includes(FLOODGATE))).toBe(true)
    expect((await h.app.queries.get(owner, server.id)).bedrock).toEqual({
      on: true,
      needsOtherVersions: false,
      moves: false,
    })
    // Changing the choice on Free is allowed, and the server stays a plain Paper server.
    await h.app.revisions.changeBedrock(owner, server.id, false, randomUUID())
    await h.until(server.id, 'running')
    await h.app.revisions.changeBedrock(owner, server.id, true, randomUUID())
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(existsSync(keyFile(server.id))).toBe(true)
    const after = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    expect(after.mods).toEqual([])
  }, 120_000)
})

describe.skipIf(!hasDatabase)('Bedrock players as players', () => {
  test('a Bedrock entry survives the server switching to checking accounts, and an invite knows it', async () => {
    geyser.introduce('Pixel Pal', '2535400000000000')
    const owner = await h.user('Jett', 'plus')
    const server = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.access.setWhitelistEnabled(owner, server.id, true)
    await h.app.access.add(owner, server.id, 'whitelist', '.Pixel Pal')
    await h.settled(server.id)
    const entry = async () =>
      (await h.app.queries.access(owner, server.id)).entries.find(
        (e) => e.player.uuid === '00000000-0000-0000-0009-01eed05d1000',
      )
    expect(await entry()).toMatchObject({ state: 'active', player: { name: '.Pixel_Pal' } })
    for (const onlineMode of [false, true]) {
      const { version } = await h.server(server.id)
      await h.app.revisions.changeAuthentication(owner, server.id, onlineMode, randomUUID(), { version })
      await h.settled(server.id, 20_000)
      // Neither dropped nor made another player: the same entry, as it was.
      expect(await entry()).toMatchObject({ state: 'active', player: { name: '.Pixel_Pal' } })
    }
    // The friend opening the invite with their gamertag is the same person, already on the list.
    const { inviteCode } = await h.server(server.id)
    expect(await h.app.sharing.joinThroughInvite(inviteCode, 'Pixel Pal')).toMatchObject({
      added: false,
      playerName: 'Pixel_Pal',
    })
    expect(await h.app.sharing.joinThroughInvite(inviteCode, '.Pixel Pal')).toMatchObject({ added: false })
  }, 180_000)

  test('a server with mods has no choice', async () => {
    // Fabric comes with Plus.
    const owner = await h.user('Elm', 'plus')
    const server = await h.create(owner, { loader: 'fabric', gameVersion: '26.2' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(existsSync(keyFile(server.id))).toBe(false)
    expect((await h.app.queries.get(owner, server.id)).bedrock).toBeNull()
    await expect(h.app.revisions.changeBedrock(owner, server.id, false, randomUUID())).rejects.toThrow(
      'only a server without mods',
    )
  }, 30_000)
})
