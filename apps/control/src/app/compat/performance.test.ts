// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The performance mods Cubepals adds to every Fabric server: placed as it starts, never among its
 * owner's mods, taken away where they are turned off, and never why a server won't start.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { FERRITECORE, LITHIUM } from '../../minecraft/mods.ts'
import type { PerformancePin, PerformancePins } from '../../minecraft/performance-pins.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { listBackups } from '../backups/persistence.ts'
import { loadRevision } from '../servers/persistence.ts'
import { ownModsOf, performanceFor, performanceOff, setPerformance } from './performance.ts'

let h: Harness
const cdn = new Cdn()
const operations = schema.serverOperations

/** One of the mods on the catalog, under its real project id, for every release Cubepals offers. */
const published = (projectId: string, name: string) => {
  const file = cdn.file(`${projectId}-1`)
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
        versionLabel: '1.0',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['fabric'],
        gameVersions: offeredVersions().map((offered) => offered.id),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file,
        dependencies: [],
      },
      // A newer release than the one Cubepals names: never taken because it is newer.
      {
        versionId: `${projectId}-2`,
        projectId,
        versionLabel: '2.0',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['fabric'],
        gameVersions: offeredVersions().map((offered) => offered.id),
        publishedAt: new Date(Date.UTC(2026, 5, 1)),
        file: cdn.file(`${projectId}-2`),
        dependencies: [],
      },
    ],
  )
  return { projectId, versionId: `${projectId}-1`, sha512: file.sha512 }
}

/** The releases named for every release Cubepals offers, as `minecraft/performance-pins.ts` names real ones. */
const namedFor = (pins: PerformancePin[]): PerformancePins =>
  Object.fromEntries(offeredVersions().map((offered) => [offered.id, pins]))
let named: PerformancePin[] = []

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness()
  named = [published(LITHIUM, 'Lithium'), published(FERRITECORE, 'FerriteCore')]
  await h.app.setups.compat.pinPerformance(namedFor(named))
}, 30_000)

afterEach(() => {
  if (hasDatabase) h.minecraft.breakOn(() => null)
})

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

const OWN = /^mods\/cubepals-/

/** What Cubepals' own step places on a server's start, by path, from the spec it boots. */
const placed = async (id: string) => {
  const { spec } = await h.app.specs.desired(h.db, await h.server(id))
  return (spec.env.BLOCKLY_JARS ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0] ?? '')
}

/** Cubepals' own jars in the server's mods folder on its disk. */
const onDisk = (id: string) => {
  const dir = `${h.runtime.machine(id)?.dir ?? ''}/mods`
  return (existsSync(dir) ? readdirSync(dir) : []).filter((file) => file.startsWith('cubepals-'))
}

/** A Fabric server with no mods of its owner's, running. */
const fabric = async (name: string) => {
  const owner = await h.user(name, 'plus')
  const server = await h.create(owner, { loader: 'fabric' })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  return { owner, id: server.id }
}

/** The steps the server's newest operation of a kind went through. */
const stepsOf = async (id: string, kind: 'start' | 'restart') => {
  const [row] = await h.db
    .select({ steps: operations.steps, status: operations.status })
    .from(operations)
    .where(and(eq(operations.serverId, id), eq(operations.kind, kind)))
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return { steps: (row?.steps ?? []).map((entry) => entry.step), status: row?.status }
}

const restart = async (owner: Awaited<ReturnType<typeof fabric>>['owner'], id: string) => {
  await h.app.servers.restart(owner, id, randomUUID())
  await h.settled(id)
}

describe.skipIf(!hasDatabase)('the performance mods every Fabric server starts with', () => {
  test('a Fabric server gets both, which are not its owner’s mods', async () => {
    const { owner, id } = await fabric('Ash')
    const server = await h.server(id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.loader).toBe('fabric')
    expect(revision.mods).toEqual([])
    const own = (await placed(id)).filter((path) => OWN.test(path))
    expect(own).toHaveLength(2)
    for (const projectId of [LITHIUM, FERRITECORE])
      expect(own.some((path) => path.includes(projectId))).toBe(true)
    // On the server's disk, placed as it started, and nowhere in what its owner chose.
    expect(onDisk(id)).toHaveLength(2)
    expect((await h.app.specs.desired(h.db, server)).spec.env.MODS ?? '').toBe('')
    expect((await h.app.accountQueries.overview(owner)).plan.key).toBe('plus')
  }, 60_000)

  test('a Paper server gets none', async () => {
    const owner = await h.user('Birch')
    const server = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect((await placed(server.id)).filter((path) => OWN.test(path))).toEqual([])
    const revision = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    expect(await performanceFor(h.db, server.id, revision)).toEqual([])
  }, 60_000)

  test('one its owner runs already is theirs, and isn’t added twice; a pack gets none', async () => {
    const { id } = await fabric('Cedar')
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const all = await performanceFor(h.db, id, revision)
    const lithium = all.find((mod) => mod.name === 'Lithium')
    if (lithium === undefined) throw new Error('Lithium was not pinned')
    const { dir: _dir, ...theirs } = lithium
    const beside = await performanceFor(h.db, id, { ...revision, mods: [theirs] })
    expect(beside.map((mod) => mod.name)).toEqual(['FerriteCore'])
    // The same mod from an upload, known only by its name.
    const uploaded = { ...theirs, name: 'lithium', source: { catalog: 'upload' } as never }
    const besideUpload = await performanceFor(h.db, id, { ...revision, mods: [uploaded] })
    expect(besideUpload.map((mod) => mod.name)).toEqual(['FerriteCore'])
    // A pack is tested as it is.
    const pack = { ...revision, modpack: {} as never }
    expect(await performanceFor(h.db, id, pack)).toEqual([])
  }, 60_000)

  test('turned off, the next start takes them away, and turned on, puts them back', async () => {
    const { owner, id } = await fabric('Dune')
    expect(onDisk(id)).toHaveLength(2)
    await setPerformance(h.db, id, false)
    expect(await performanceOff(h.db, id)).toBe('owner')
    expect((await placed(id)).filter((path) => OWN.test(path))).toEqual([])
    // Nothing restarts for it: they go at its next start.
    expect(onDisk(id)).toHaveLength(2)
    await restart(owner, id)
    expect(onDisk(id)).toEqual([])
    await setPerformance(h.db, id, true)
    expect(await performanceOff(h.db, id)).toBeNull()
    await restart(owner, id)
    expect(onDisk(id)).toHaveLength(2)
  }, 90_000)
})

describe.skipIf(!hasDatabase)('a start that fails with Cubepals’ own mods', () => {
  test('comes up without them, which are then off for the server, and its record says so', async () => {
    const { owner, id } = await fabric('Elm')
    h.minecraft.breakOn((env) => (OWN.test(env.BLOCKLY_JARS ?? '') ? 'one of them clashed with a mod' : null))
    await restart(owner, id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await performanceOff(h.db, id)).toBe('clash')
    expect(onDisk(id)).toEqual([])
    const last = await stepsOf(id, 'restart')
    expect(last.status).toBe('succeeded')
    expect(last.steps).toContain('own_mods_off')
    // And it stays so: the next start places none, until its owner turns them back on.
    h.minecraft.breakOn(() => null)
    await restart(owner, id)
    expect(onDisk(id)).toEqual([])
  }, 120_000)

  test('that fails without them too has them back: they were not why', async () => {
    const { owner, id } = await fabric('Fir')
    h.minecraft.breakOn(() => 'its world would not open')
    await restart(owner, id)
    expect((await stepsOf(id, 'restart')).status).toBe('failed')
    expect((await stepsOf(id, 'restart')).steps).not.toContain('own_mods_off')
    expect(await performanceOff(h.db, id)).toBeNull()
  }, 120_000)

  test('an owner who turned them off while it was tried without them keeps that choice', async () => {
    const { id } = await fabric('Hazel')
    const own = ownModsOf(h.db)
    await own.turnOff(id)
    await setPerformance(h.db, id, false)
    await own.turnOn(id)
    expect(await performanceOff(h.db, id)).toBe('owner')
    // With no choice of theirs since, the start's own turning off is taken back.
    await setPerformance(h.db, id, true)
    await own.turnOff(id)
    await own.turnOn(id)
    expect(await performanceOff(h.db, id)).toBeNull()
    // And one who turned them off just before the start did: theirs is not renamed, or taken back.
    await setPerformance(h.db, id, false)
    await own.turnOff(id)
    expect(await performanceOff(h.db, id)).toBe('owner')
    await own.turnOn(id)
    expect(await performanceOff(h.db, id)).toBe('owner')
  }, 60_000)

  test('where it can’t be tried again, a restore, leaves them off for the next start', async () => {
    const { owner, id } = await fabric('Ivy')
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [backup] = (await listBackups(h.db, id)).filter((b) => b.status === 'ready')
    if (backup === undefined) throw new Error('No backup was taken')
    h.minecraft.breakOn((env) => (OWN.test(env.BLOCKLY_JARS ?? '') ? 'one of them clashed with a mod' : null))
    await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect(await performanceOff(h.db, id)).toBe('clash')
    // Its next start places none, so they are not what stops it.
    await restart(owner, id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(onDisk(id)).toEqual([])
  }, 120_000)

  test('a server its owner turned them off for is started as it is', async () => {
    const { owner, id } = await fabric('Gorse')
    await setPerformance(h.db, id, false)
    await restart(owner, id)
    h.minecraft.breakOn(() => 'its world would not open')
    await restart(owner, id)
    expect((await stepsOf(id, 'restart')).status).toBe('failed')
    expect(await performanceOff(h.db, id)).toBe('owner')
  }, 120_000)
})

describe.skipIf(!hasDatabase)('which releases of them are pinned', () => {
  const pinsOf = async () =>
    (await h.db.select().from(schema.compatPlugins))
      .filter((row) => [LITHIUM, FERRITECORE].includes(row.projectId))
      .map((row) => (row.pinned as { source: { versionId: string } }).source.versionId)

  test('only the release named, though its project published a newer one', async () => {
    expect(new Set(await pinsOf())).toEqual(new Set([`${LITHIUM}-1`, `${FERRITECORE}-1`]))
  })

  test('none whose file is not the one named, and one no longer named goes', async () => {
    const [lithium, ferrite] = named
    if (lithium === undefined || ferrite === undefined) throw new Error('Nothing was named')
    // The same release with another file than the one written down: not pinned, and the one kept goes.
    await h.app.setups.compat.pinPerformance(namedFor([{ ...lithium, sha512: 'f'.repeat(128) }, ferrite]))
    expect(new Set(await pinsOf())).toEqual(new Set([`${FERRITECORE}-1`]))
    // Named again as it is published, it is pinned again; nothing named, nothing stays.
    await h.app.setups.compat.pinPerformance(namedFor(named))
    expect(new Set(await pinsOf())).toEqual(new Set([`${LITHIUM}-1`, `${FERRITECORE}-1`]))
    await h.app.setups.compat.pinPerformance({})
    expect(await pinsOf()).toEqual([])
    await h.app.setups.compat.pinPerformance(namedFor(named))
  }, 60_000)
})
