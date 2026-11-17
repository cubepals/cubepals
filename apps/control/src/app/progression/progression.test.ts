// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline world progression (`progression.ts`): on for every server it is for, existing ones
 * included, placed as a start begins and never through drift; the owner's switch turns it off and
 * back, restarting nothing; a sleeping server boots once for it either way; and none on a server
 * whose type can't run it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAY_MS } from '@blockly/contracts/durations'
import { until } from '@blockly/contracts/waits'
import { schema } from '@blockly/db'
import { asc, eq } from 'drizzle-orm'
import { jar } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { requestedBy } from '../actor.ts'
import { storedArtifact } from '../artifacts/persistence.ts'
import { PROGRESSION_MOD, PROGRESSION_PLUGIN } from '../artifacts/progression-jar.ts'
import { AppError } from '../errors.ts'
import { deriveServerSecret, singleKey } from '../secrets.ts'
import { loadRevision } from '../servers/persistence.ts'
import {
  FABRIC_RELEASE,
  PROGRESSION_ENV,
  progressionAtStart,
  progressionKind,
  progressionOff,
  setProgression,
} from './progression.ts'

const folder = mkdtempSync(join(tmpdir(), 'progression-'))
const plugin = jar('cubepals-progression')
const mod = jar('cubepals-progression-fabric')
const sha = (bytes: Buffer) => createHash('sha512').update(bytes).digest('hex')

let h: Harness
const DEFAULTS = { furnaces: true, plants: true, animals: true, world: true, fire: false }
/** Where the jars are kept and fetched from, serving them as a real store does. */
const store = new MemoryStore()

beforeAll(async () => {
  if (!hasDatabase) return
  writeFileSync(join(folder, 'plugin.jar'), plugin)
  writeFileSync(join(folder, 'mod.jar'), mod)
  PROGRESSION_PLUGIN.use(join(folder, 'plugin.jar'))
  PROGRESSION_MOD.use(join(folder, 'mod.jar'))
  await store.start()
  h = await startHarness({ capabilities: { archives: store, billing: null } })
  await until(
    'both jars stored',
    async () =>
      (await storedArtifact(h.db, sha(plugin))) !== null && (await storedArtifact(h.db, sha(mod))) !== null,
  )
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  store.close()
  PROGRESSION_PLUGIN.use()
  PROGRESSION_MOD.use()
  rmSync(folder, { recursive: true, force: true })
})

/** The lines of Cubepals' own step that place the plugin or the mod, by path. */
const placed = async (id: string) => {
  const { spec } = await h.app.specs.desired(h.db, await h.server(id))
  return (spec.env.BLOCKLY_JARS ?? '')
    .split('\n')
    .filter((line) => line.includes(sha(plugin)) || line.includes(sha(mod)))
    .map((line) => line.split(' ')[0] ?? '')
}

const running = async (name: string, request: Parameters<Harness['create']>[1]) => {
  const owner = await h.user(name, 'plus')
  const { id } = await h.create(owner, request)
  await h.until(id, 'running')
  await h.settled(id)
  return { owner, id }
}

/** A Smooth server: Paper, no plugins of its owner's. */
const paper = (name: string) => running(name, { from: { kind: 'template', key: 'smooth' } })
/** A Fabric server on the release the mod is built for. */
const fabric = (name: string) => running(name, { loader: 'fabric' })

const audited = async (id: string) =>
  (
    await h.db
      .select({ actor: schema.auditLog.actor, action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, id))
      .orderBy(asc(schema.auditLog.at))
  ).filter((row) => row.action.startsWith('server.progression_'))

describe('which servers take it', () => {
  const base = { gameVersion: '26.3', loaderVersion: null, modpack: null, mods: [] }

  test('Paper, and plain Minecraft on Paper, take the plugin; Fabric on the mod’s release takes the mod', () => {
    expect(progressionKind({ ...base, loader: 'paper', loaderVersion: '253' })).toBe('plugin')
    expect(progressionKind({ ...base, loader: 'paper', gameVersion: '1.20.1', loaderVersion: '196' })).toBe(
      'plugin',
    )
    expect(progressionKind({ ...base, loader: 'vanilla', loaderVersion: '253' })).toBe('plugin')
    expect(progressionKind({ ...base, loader: 'fabric' })).toBe('mod')
  })

  test('none where it can’t run: Mojang’s own server, a pack, other Fabric releases and other loaders', () => {
    expect(progressionKind({ ...base, loader: 'vanilla' })).toBeNull()
    expect(
      progressionKind({ ...base, loader: 'paper', loaderVersion: '253', modpack: {} as never }),
    ).toBeNull()
    expect(progressionKind({ ...base, loader: 'fabric', modpack: {} as never })).toBeNull()
    expect(progressionKind({ ...base, loader: 'fabric', gameVersion: '26.2' })).toBeNull()
    expect(progressionKind({ ...base, loader: 'fabric', gameVersion: '26.30' })).toBeNull()
    for (const loader of ['quilt', 'forge', 'neoforge'] as const)
      expect(progressionKind({ ...base, loader })).toBeNull()
  })

  test('the release the control plane places the mod on is the one the mod says it runs on', () => {
    const declared = JSON.parse(
      readFileSync(
        new URL('../../../../progression/fabric/src/main/resources/fabric.mod.json', import.meta.url),
        'utf8',
      ),
    ) as { depends: { minecraft: string } }
    expect(declared.depends.minecraft).toBe(`~${FABRIC_RELEASE}`)
  })
})

describe.skipIf(!hasDatabase)('Offline world progression', () => {
  test('is on for a Paper server, and its start places the plugin, never through drift', async () => {
    const { owner, id } = await paper('Ash')
    expect(await placed(id)).toEqual([expect.stringMatching(/^plugins\/.*cubepals-progression\.jar$/)])
    expect((await h.app.queries.get(owner, id)).progression).toEqual({
      on: true,
      turnedOff: null,
      parts: DEFAULTS,
    })
    const token = deriveServerSecret(
      singleKey('test-runtime-secrets-key-0123456789').current.key,
      id,
      'artifacts',
    )
    const located = await h.app.artifacts.locate(id, sha(plugin), token)
    expect(located.name).toEndWith('cubepals-progression.jar')
  }, 60_000)

  test('is on for a Fabric server on its release, whose start places the mod', async () => {
    const { owner, id } = await fabric('Birch')
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision.gameVersion).toBe(FABRIC_RELEASE)
    expect(await placed(id)).toEqual([expect.stringMatching(/^mods\/.*cubepals-progression-fabric\.jar$/)])
    expect((await h.app.queries.get(owner, id)).progression).toEqual({
      on: true,
      turnedOff: null,
      parts: DEFAULTS,
    })
  }, 60_000)

  test('its owner turns it off and on, audited, and nothing restarts or makes a revision', async () => {
    const { owner, id } = await paper('Cedar')
    const before = await h.server(id)
    const runningSpec = await h.app.specs.desired(h.db, before)

    await h.app.servers.progression.set(owner, id, false)
    expect(await progressionOff(h.db, id)).toBe('owner')
    expect(await placed(id)).toEqual([])
    expect((await h.app.queries.get(owner, id)).progression).toEqual({
      on: false,
      turnedOff: 'owner',
      parts: DEFAULTS,
    })
    const off = await h.app.specs.desired(h.db, await h.server(id))
    // A running server isn't restarted for it; a sleeping one boots once to leave it out.
    expect(off.driftDigest).toBe(runningSpec.driftDigest)
    expect(off.spec.resumesOn).not.toBe(runningSpec.spec.resumesOn)
    // Pressed again, nothing more happens.
    await h.app.servers.progression.set(owner, id, false)

    await h.app.servers.progression.set(owner, id, true)
    expect(await progressionOff(h.db, id)).toBeNull()
    expect(await placed(id)).toHaveLength(1)
    expect((await h.app.specs.desired(h.db, await h.server(id))).spec.resumesOn).toBe(
      runningSpec.spec.resumesOn,
    )

    const after = await h.server(id)
    expect(after.lifecycle.status).toBe('running')
    expect(after.desiredRevisionId).toBe(before.desiredRevisionId)
    expect(after.version).toBe(before.version + 2)
    expect(await audited(id)).toEqual(
      ['server.progression_off', 'server.progression_on'].map((action) => ({
        actor: requestedBy(owner),
        action,
      })),
    )
  }, 60_000)

  test('is the owner’s alone to switch, and refused on a server it isn’t for', async () => {
    const { id } = await paper('Dune')
    const other = await h.user('Elm', 'plus')
    await expect(h.app.servers.progression.set(other, id, false)).rejects.toThrow()
    expect(await progressionOff(h.db, id)).toBeNull()

    // Plain Minecraft on Mojang's own server takes no plugins.
    const { owner, id: mojang } = await running('Fir', { loader: 'vanilla' })
    const revision = await loadRevision(h.db, (await h.server(mojang)).desiredRevisionId)
    expect(revision.loaderVersion).toBeNull()
    expect((await h.app.queries.get(owner, mojang)).progression).toBeNull()
    expect(await placed(mojang)).toEqual([])
    await expect(h.app.servers.progression.set(owner, mojang, false)).rejects.toBeInstanceOf(AppError)
  }, 60_000)

  test('a start that failed with the mod turns it off, and only that is taken back', async () => {
    const { id } = await fabric('Gorse')
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const atStart = progressionAtStart(h.db)
    expect(await atStart.placed(id, revision)).toBe(true)
    await atStart.turnOff(id)
    expect(await progressionOff(h.db, id)).toBe('clash')
    expect(await placed(id)).toEqual([])
    await atStart.turnOn(id)
    expect(await progressionOff(h.db, id)).toBeNull()
    // The owner's own choice, made meanwhile, stands.
    await setProgression(h.db, id, false, 'owner')
    await atStart.turnOff(id)
    await atStart.turnOn(id)
    expect(await progressionOff(h.db, id)).toBe('owner')
  }, 60_000)
})

describe.skipIf(!hasDatabase)('Offline world progression’s parts, and its jars', () => {
  test('a start is given the parts that are on: all but fire, until its owner changes one', async () => {
    const { owner, id } = await paper('Hazel')
    const env = async () => (await h.app.specs.desired(h.db, await h.server(id))).spec.env[PROGRESSION_ENV]
    expect(await env()).toBe('furnaces,plants,animals,world')
    expect((await h.app.queries.get(owner, id)).progression?.parts).toEqual({
      furnaces: true,
      plants: true,
      animals: true,
      world: true,
      fire: false,
    })
    const before = await h.app.specs.desired(h.db, await h.server(id))

    await h.app.servers.progression.setPart(owner, id, 'world', false)
    await h.app.servers.progression.setPart(owner, id, 'fire', true)
    // Pressed again, nothing more happens.
    await h.app.servers.progression.setPart(owner, id, 'fire', true)
    expect(await env()).toBe('furnaces,plants,animals,fire')
    const after = await h.app.specs.desired(h.db, await h.server(id))
    // The next start has it; a running server isn't restarted, and a sleeping one boots once.
    expect(after.digest).not.toBe(before.digest)
    expect(after.driftDigest).toBe(before.driftDigest)
    expect(after.spec.resumesOn).not.toBe(before.spec.resumesOn)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const parts = (
      await h.db
        .select({ action: schema.auditLog.action, data: schema.auditLog.data })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.subjectId, id))
        .orderBy(asc(schema.auditLog.at))
    ).filter((row) => row.action.startsWith('server.progression_part_'))
    expect(parts).toEqual([
      { action: 'server.progression_part_off', data: { part: 'world' } },
      { action: 'server.progression_part_on', data: { part: 'fire' } },
    ])

    // With progression off, no part reaches the start, and the parts are kept for when it's back.
    await h.app.servers.progression.set(owner, id, false)
    expect(await env()).toBeUndefined()
    await h.app.servers.progression.set(owner, id, true)
    expect(await env()).toBe('furnaces,plants,animals,fire')
  }, 60_000)

  test('the jars are kept in the store, and never collected as unused', async () => {
    await h.app.artifacts.collectGarbage(new Date(Date.now() + 400 * DAY_MS))
    expect(await storedArtifact(h.db, sha(plugin))).not.toBeNull()
    expect(await storedArtifact(h.db, sha(mod))).not.toBeNull()
  })
})
