// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player's game has to match, on a server's routes (`players-mods.ts`): every jar with its
 * version, those the last change of mods moved first and when; a pack as itself; nothing for
 * plugins, datapacks or a pack that runs on the server alone. Then, on the routes themselves: the
 * mods of the run a running server booted, until a change saved since boots.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { insertRevision, loadRevision } from '../servers/persistence.ts'
import { MOST_LISTED, playersMods, type RevisionMods } from './players-mods.ts'

/** A pin of `name` at `version`, as its catalog's version `name@version`, read as `inputs.ts` reads it. */
const mod = (
  name: string,
  version: string,
  environment: PinnedMod['environment'] = 'optional',
  loaders = ['fabric'],
): RevisionMods['mods'][number] & Pick<PinnedMod, 'source'> => ({
  name,
  versionLabel: version,
  environment,
  loaders,
  file: `${name}@${version}`,
  source: { catalog: 'modrinth', projectId: name, versionId: `${name}@${version}` },
})

const at = (day: number) => new Date(Date.UTC(2026, 10, day))

const revision = (
  day: number,
  mods: RevisionMods['mods'],
  fields: Partial<RevisionMods> = {},
): RevisionMods => ({
  loader: 'fabric',
  mods,
  modpack: null,
  createdAt: at(day),
  ...fields,
})

describe('what a player’s game matches', () => {
  test('every jar with its version: what the last change moved first, then what players need', () => {
    const before = [
      mod('VeinMiner', '2.13.0', 'both'),
      mod('Collective', '8.64'),
      mod('FerriteCore', '9.0.0', 'server'),
    ]
    const after = [
      mod('VeinMiner', '2.14.0', 'server'),
      mod('Collective', '8.87'),
      mod('FerriteCore', '9.0.0', 'server'),
    ]
    const extra = [mod('AppleSkin', '3.0.10'), mod('Voice', '2.6', 'both')]
    // Newest first: a settings change since, the change of mods, and the server's first revision.
    const history = [
      revision(16, [...after, ...extra]),
      revision(16, [...after, ...extra]),
      revision(4, [...before, ...extra]),
    ]
    expect(playersMods(history)).toEqual({
      list: [
        { name: 'Collective', version: '8.87', changed: true },
        { name: 'VeinMiner', version: '2.14.0', changed: true },
        { name: 'Voice', version: '2.6' },
        { name: 'AppleSkin', version: '3.0.10' },
        { name: 'FerriteCore', version: '9.0.0' },
      ],
      changedAt: at(16).toISOString(),
    })
  })

  test('a server whose mods never changed says no date; a long list says how many more', () => {
    const many = Array.from({ length: MOST_LISTED + 3 }, (_, i) =>
      mod(`Mod ${String(i).padStart(2, '0')}`, '1.0'),
    )
    expect(playersMods([revision(1, many), revision(1, many)])).toEqual({
      list: many.slice(0, MOST_LISTED).map((m) => ({ name: m.name, version: '1.0' })),
      more: 3,
    })
  })

  test('nothing for plugins, datapacks, plain Minecraft or a pack the server runs alone', () => {
    expect(
      playersMods([revision(1, [mod('LuckPerms', '5.4', 'server', ['paper'])], { loader: 'paper' })]),
    ).toBeUndefined()
    expect(
      playersMods([revision(1, [mod('Trees', '1.0', 'server', ['datapack'])], { loader: 'vanilla' })]),
    ).toBeUndefined()
    expect(playersMods([revision(1, [mod('Trees', '1.0', 'server', ['datapack'])])])).toBeUndefined()
    expect(playersMods([revision(1, [])])).toBeUndefined()
    expect(playersMods([])).toBeUndefined()
    const pack = (environment: 'server' | 'both', versionId = 'v52') => ({
      name: 'Better MC',
      versionLabel: versionId,
      versionId,
      environment,
    })
    expect(playersMods([revision(1, [], { modpack: pack('server') })])).toBeUndefined()
    // A pack is matched as itself, and a move to another of its versions is a change.
    expect(
      playersMods([
        revision(9, [], { modpack: pack('both', 'v53') }),
        revision(1, [], { modpack: pack('both') }),
      ]),
    ).toEqual({
      list: [{ name: 'Better MC', version: 'v53', changed: true }],
      changedAt: at(9).toISOString(),
      pack: true,
    })
  })
})

describe.skipIf(!hasDatabase)('a route’s mods', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('are the run’s a running server booted, with what its last change of mods moved', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const route = async () =>
      (await h.app.edge.routes()).routes.find((r) => r.hostname === `${slug}.play.test`)
    const madeAt = async (revisionId: string) => {
      const [row] = await h.db
        .select({ at: schema.serverRevisions.createdAt })
        .from(schema.serverRevisions)
        .where(eq(schema.serverRevisions.id, revisionId))
      return row?.at.toISOString()
    }
    // Plain Minecraft asks nothing of a player's game.
    expect((await route())?.mods).toBeUndefined()

    // It boots on Fabric with two mods; then one of them moves, saved for its next start.
    const booted = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const { id: _id, serverId: _server, number: _number, createdBy: _by, ...draft } = booted
    const first = [mod('VeinMiner', '2.13.0', 'both'), mod('AppleSkin', '3.0.10')] as unknown as PinnedMod[]
    const fabric = await h.db.transaction((tx) =>
      insertRevision(tx, id, { ...draft, loader: 'fabric', mods: first }, owner.userId),
    )
    await h.db
      .update(schema.serverRuntimes)
      .set({
        applied: sql`${schema.serverRuntimes.applied} || ${JSON.stringify({ revisionId: fabric.id })}::jsonb`,
      })
      .where(eq(schema.serverRuntimes.serverId, id))
    // Plain Minecraft before it carried none: every one of them is what changed, in the order the
    // server's page lists them (`inPlayersGames`), what players' games need first.
    const booting = {
      list: [
        { name: 'VeinMiner', version: '2.13.0', changed: true as const },
        { name: 'AppleSkin', version: '3.0.10', changed: true as const },
      ],
      changedAt: await madeAt(fabric.id),
    }
    expect((await route())?.mods).toEqual(booting)

    const moved = await h.db.transaction((tx) =>
      insertRevision(
        tx,
        id,
        {
          ...draft,
          loader: 'fabric',
          mods: [mod('VeinMiner', '2.14.0', 'server'), first[1]] as unknown as PinnedMod[],
        },
        owner.userId,
      ),
    )
    await h.db
      .update(schema.minecraftServers)
      .set({ desiredRevisionId: moved.id })
      .where(eq(schema.minecraftServers.id, id))
    // Running, it still plays what it booted.
    expect((await route())?.mods).toEqual(booting)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    expect((await route())?.mods).toEqual({
      list: [
        { name: 'VeinMiner', version: '2.14.0', changed: true },
        { name: 'AppleSkin', version: '3.0.10' },
      ],
      changedAt: await madeAt(moved.id),
    })
  }, 30_000)

  test('are read cut short: an owner’s long names never make a read of the routes large', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    const booted = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const { id: _id, serverId: _server, number: _number, createdBy: _by, ...draft } = booted
    // An upload names itself: here, far longer than any name a person reads.
    const upload = {
      name: 'N'.repeat(100_000),
      versionLabel: 'V'.repeat(100_000),
      environment: 'optional',
      loaders: Array.from({ length: 1000 }, () => 'fabric'),
      source: { catalog: 'upload', uploadId: 'U'.repeat(10_000) },
    } as unknown as PinnedMod
    const long = await h.db.transaction((tx) =>
      insertRevision(tx, id, { ...draft, loader: 'fabric', mods: [upload] }, owner.userId),
    )
    await h.db
      .update(schema.minecraftServers)
      .set({ desiredRevisionId: long.id })
      .where(eq(schema.minecraftServers.id, id))
    const route = (await h.app.edge.routes()).routes.find((r) => r.hostname === `${slug}.play.test`)
    expect(route?.mods?.list).toEqual([{ name: 'N'.repeat(64), version: 'V'.repeat(64), changed: true }])
  }, 30_000)
})
