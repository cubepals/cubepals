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
import { FLOODGATE, FLOODGATE_KEY_ENV } from '../../minecraft/bedrock.ts'
import { VIABACKWARDS, VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'

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
    expect((await h.app.queries.get(owner, id)).bedrock).toBe(true)
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
    expect((await h.app.queries.get(owner, id)).bedrock).toBe(false)

    await h.app.revisions.changeBedrock(owner, id, true, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(existsSync(keyFile(id))).toBe(true)
  }, 90_000)

  test('Bedrock keeps ViaVersion on a server that lets no other versions in', async () => {
    const { owner, id } = await smooth('Dune')
    await h.app.revisions.changeOtherVersions(owner, id, 'off', randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const { jars } = await jarsOf(id)
    expect(jars.some((line) => line.includes(FLOODGATE))).toBe(true)
    expect(jars.some((line) => line.includes(VIAVERSION))).toBe(true)
  }, 90_000)

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
    expect((await h.app.queries.get(owner, server.id)).bedrock).toBe(true)
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

  test('only a Paper server has the choice', async () => {
    const owner = await h.user('Elm')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(existsSync(keyFile(server.id))).toBe(false)
    expect((await h.app.queries.get(owner, server.id)).bedrock).toBeNull()
    await expect(h.app.revisions.changeBedrock(owner, server.id, false, randomUUID())).rejects.toThrow(
      'Only a Paper server',
    )
  }, 30_000)
})
