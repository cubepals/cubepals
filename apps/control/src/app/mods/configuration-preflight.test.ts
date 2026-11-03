// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Proposed revisions and curated packs use the same real planner, runtime proof and learned exclusions. */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { type CuratedFactsJson, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { planThatRuns } from '../../domain/account/entitlements.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import { MEMORY_TIERS } from '../../domain/server/size.ts'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { INDEX_FILE } from '../../minecraft/mrpack.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import type { Checked } from '../curation/check-outcome.ts'
import { PackContents } from '../packs/contents.ts'
import { loadRevision } from '../servers/persistence.ts'
import { ConfigurationPreflight } from './configuration-preflight.ts'
import { validationKey } from './validation-plan.ts'
import { IncompatibleMods } from './validation-runtime.ts'

describe.skipIf(!hasDatabase)('shared configuration preflight', () => {
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
  test(
    'the proposed runtime is verified without changing the player world or revision',
    () => proposed(h, cdn),
    30_000,
  )
  test(
    'a curated pack learns an actual client crash before its corrected plan is verified',
    () => learnedPack(h, cdn),
    30_000,
  )
})

async function proposed(h: Harness, cdn: Cdn) {
  expect(h.app.configuration).toBeInstanceOf(ConfigurationPreflight)
  const { server, revision } = await serverFor(h, 'Proposed compatibility')
  const id = server.id
  const checking = mock(async () => {})
  await h.app.configuration.check(revision, undefined, checking)
  expect(checking).not.toHaveBeenCalled()
  expect(await h.app.configuration.request(revision)).toBeNull()
  const mod = cdn.publish(randomUUID())
  const candidate = {
    ...revision,
    mods: [mod],
    settings: { ...revision.settings, pvp: false, maxPlayers: 7 },
  }
  const desired = await h.app.specs.forRevision(h.db, server, candidate)
  const plan = await h.app.configuration.plan(candidate, desired)
  expect(plan).toMatchObject({
    gameVersion: desired.revision.gameVersion,
    loader: desired.revision.loader,
    loaderVersion: desired.revision.loaderVersion,
    settings: desired.revision.settings,
    mods: desired.validation.mods,
    compat: desired.validation.compat,
    files: desired.validation.files,
    modpack: null,
    memoryTier: server.memoryTier,
    storageGb: desired.spec.storage.sizeGb,
    provider: h.runtime.provider,
    regionKey: server.regionKey,
  })
  if (plan === null) throw new Error('Missing proposed plan')
  const artifacts = spyOn(h.app.artifacts, 'preflight')
  await h.app.configuration.check(candidate, desired, checking)
  expect(artifacts).toHaveBeenLastCalledWith({
    ...candidate,
    mods: [...plan.mods, ...plan.compat],
    modpack: null,
  })
  const companion = cdn.publish(randomUUID())
  const sidecar = { ...desired, validation: { ...desired.validation, mods: [], compat: [companion] } }
  expect(await h.app.configuration.plan(candidate, sidecar)).toMatchObject({ mods: [], compat: [companion] })
  try {
    await h.app.configuration.check(candidate, sidecar)
    expect(artifacts).toHaveBeenLastCalledWith({ ...candidate, mods: [companion], modpack: null })
  } finally {
    artifacts.mockRestore()
  }
  expect(checking).toHaveBeenCalledTimes(1)
  const proof = await h.app.configuration.request(candidate)
  expect(proof).toMatchObject({ key: validationKey(plan), state: 'verified' })
  const [record] = await h.db
    .select()
    .from(schema.modValidations)
    .where(eq(schema.modValidations.key, validationKey(plan)))
  expect(record?.evidence?.installed).toContain(mod.artifact.sha512)
  expect((await h.server(id)).desiredRevisionId).toBe(server.desiredRevisionId)
  expect((await h.server(id)).activeWorldId).toBe(server.activeWorldId)
  await expect(h.app.configuration.plan({ ...candidate, serverId: randomUUID() })).rejects.toThrow(
    'unavailable',
  )
  const broken = cdn.publish('preflight-missing-balm')
  h.minecraft.breakOn((env) =>
    env.MODS?.includes('preflight-missing-balm')
      ? "Mod 'Waystones' (waystones) 21.1.25 requires any version of balm, which is missing!"
      : null,
  )
  try {
    await expect(h.app.configuration.check({ ...candidate, mods: [broken] })).rejects.toBeInstanceOf(
      IncompatibleMods,
    )
  } finally {
    h.minecraft.breakOn(() => null)
  }
}

async function learnedPack(h: Harness, cdn: Cdn) {
  const checked = await release(h, cdn)
  const { facts } = checked
  const { revision } = await serverFor(h, 'Pack planning')
  expect((await h.app.configuration.plan({ ...revision, modpack: checked.pack }))?.modpack).toEqual(
    checked.pack,
  )
  await expect(
    h.app.configuration.release({ ...checked, facts: { ...facts, tier: 'unknown' } }),
  ).rejects.toThrow('Unknown pack validation size')
  await expect(
    h.app.configuration.release({ ...checked, facts: { ...facts, loader: 'unknown' } }),
  ).rejects.toThrow()
  const unoffered = MEMORY_TIERS.find(
    (tier) => planThatRuns({ tier, loader: 'forge', modded: true }) === null,
  )
  if (unoffered === undefined) throw new Error('The offering has no unsupported fixture size')
  await expect(
    h.app.configuration.release({ ...checked, facts: { ...facts, tier: unoffered, loader: 'forge' } }),
  ).rejects.toThrow('No offered size')
  h.minecraft.breakOn((env) =>
    env.MODRINTH_MODPACK && !env.MODRINTH_EXCLUDE_FILES
      ? [
          'java.awt.HeadlessException: ',
          'No X11 DISPLAY variable was set,',
          '\tat javax.swing.JFrame.<init>(Unknown Source) ~[?:?]',
          '\tat toni.fancymenu.MissingModsWindow.<init>(MissingModsWindow.java:55) ~[fancymenu.jar:?]',
        ].join('\n')
      : null,
  )
  try {
    await expect(h.app.configuration.release(checked)).rejects.toThrow('updated configuration')
    await h.app.configuration.release(checked)
    const rows = await h.db.select().from(schema.modValidations)
    const proofs = rows.filter((row) => row.plan.modpack?.artifact.sha512 === checked.pack.artifact.sha512)
    expect(proofs.map((row) => row.state).sort()).toEqual(['blocked', 'verified'])
    const verified = proofs.find((row) => row.state === 'verified')
    expect(verified?.plan).toMatchObject({
      gameVersion: facts.gameVersion,
      loader: facts.loader,
      loaderVersion: facts.loaderVersion,
      memoryTier: facts.tier,
      provider: h.runtime.provider,
      regionKey: 'local',
    })
    expect(verified?.plan.modpack?.leaveOut).toContain('mods/fancymenu.jar')
    expect(verified?.plan.settings).toMatchObject({ defaultGameMode: 'survival', maxPlayers: 1 })
    expect(verified?.handle).toBeNull()
  } finally {
    h.minecraft.breakOn(() => null)
  }
}

async function release(h: Harness, cdn: Cdn): Promise<Checked> {
  const bytes = zipBytes({
    'fabric.mod.json': utf8(JSON.stringify({ id: 'fancymenu', version: '1', environment: 'client' })),
  })
  const file = cdn.file(randomUUID(), bytes)
  const gameVersion = '26.3',
    loaderVersion = '0.19.5'
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1',
    name: 'Preflight pack',
    dependencies: { minecraft: gameVersion, 'fabric-loader': loaderVersion },
    files: [
      {
        path: 'mods/fancymenu.jar',
        hashes: { sha512: file.sha512, sha1: createHash('sha1').update(bytes).digest('hex') },
        env: { client: 'required', server: 'required' },
        downloads: [file.url],
        fileSize: file.sizeBytes,
      },
    ],
  }
  const published = cdn.publish(
    randomUUID(),
    Buffer.from(zipBytes({ [INDEX_FILE]: utf8(JSON.stringify(index)) })),
  )
  const pack: PinnedModpack = {
    catalog: 'modrinth',
    projectId: 'preflight-pack',
    versionId: '1',
    name: index.name,
    versionLabel: '1',
    artifact: published.artifact,
    page: null,
    environment: 'both',
    icon: null,
  }
  if (pack.artifact.ref.kind !== 'remote') throw new Error('Expected a published pack')
  const contents = new PackContents({
    db: h.db,
    formats: new LibraryFileFormats(),
    catalog: h.catalog,
    jarChecks: h.app.jarChecks,
  })
  expect((await contents.ofCatalog({ url: pack.artifact.ref.url, sha512: pack.artifact.sha512 })).kind).toBe(
    'read',
  )
  const facts: CuratedFactsJson = {
    gameVersion,
    loader: 'fabric',
    loaderVersion,
    tier: '3g',
    playersNeedIt: true,
    mods: 1,
    jarBytes: file.sizeBytes,
    notes: [],
    upstream: null,
    checked: { files: 1, bytes: file.sizeBytes, hosts: [] },
    code: [],
    licences: [],
    obligations: [],
    mirrorBlockers: [],
  }
  return { distribution: 'upstream', pack, facts, stored: null, contents: null, forPlayers: [] }
}

async function serverFor(h: Harness, label: string) {
  const owner = await h.user(label, 'plus')
  const { id } = await h.create(owner, { loader: 'fabric' })
  const state = await h.until(id, (server) => ['running', 'failed'].includes(server.lifecycle.status))
  expect(state.lifecycle.status).toBe('running')
  await h.settled(id)
  const server = await h.server(id)
  return { server, revision: await loadRevision(h.db, server.desiredRevisionId) }
}
