/**
 * Starting over in one step (§4), end to end: a fresh world, another round on a server made for a
 * day, and a new season where LifeStealZ runs, each with the world it leaves kept and a snapshot
 * first. What each is called is `fresh-start.ts`'s; the hearts are `minecraft/lifesteal.ts`'s.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { access as exists, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'

/** Where LifeStealZ keeps everyone's hearts; a restore puts the server on another volume. */
const hearts = (h: Harness, id: string, file = 'userData.db') =>
  h.minecraft.path(id, `plugins/LifeStealZ/${file}`)

/** The update a fresh start makes, through to the server running again. */
async function startOver(h: Harness, owner: UserActor, id: string) {
  const first = (await h.server(id)).activeWorldId
  await h.app.worlds.freshStart(owner, id, randomUUID())
  await h.until(id, (s) => s.lifecycle.status !== 'updating' && s.activeWorldId !== first, 20_000)
  await h.settled(id, 20_000)
}

describe.skipIf(!hasDatabase)('a fresh world and another round', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async (request: { temporary?: boolean } = {}) => {
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner, request)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }

  test('a fresh world from a random seed, switched to, with the one it leaves kept', async () => {
    const { owner, id } = await running()
    expect(await h.app.worldQueries.freshStart(owner, id)).toEqual({
      kind: 'world',
      name: 'World 2',
      leaving: 'World',
      hearts: null,
    })
    await startOver(h, owner, id)
    const worlds = await h.app.worldQueries.list(owner, id)
    expect(worlds.map((w) => [w.name, w.active, w.running, w.seed])).toEqual([
      ['World', false, false, null],
      ['World 2', true, true, null],
    ])
    // The world it left is in Backups as it was, as well as under Other worlds.
    expect((await listBackups(h.db, id)).map((b) => [b.trigger, b.worldId])).toContainEqual([
      'pre_apply',
      worlds[0]?.id ?? '',
    ])
    expect((await h.app.worldQueries.freshStart(owner, id)).name).toBe('World 3')
  }, 40_000)

  test('a server made for a day plays another round, and a stopped one runs it from its next start', async () => {
    const { owner, id } = await running({ temporary: true })
    expect((await h.app.worldQueries.freshStart(owner, id)).kind).toBe('round')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.app.worlds.freshStart(owner, id, randomUUID())
    const worlds = await h.app.worldQueries.list(owner, id)
    expect(worlds.map((w) => [w.name, w.active, w.running])).toEqual([
      ['World', false, true],
      ['Round 2', true, false],
    ])
  }, 40_000)
})

describe.skipIf(!hasDatabase)('a new season', () => {
  let h: Harness
  const cdn = new Cdn()

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    h.catalog.publish(
      {
        projectId: 'l8Uv7FzS',
        slug: 'lifestealz',
        name: 'LifeStealZ',
        summary: 'Hearts, for tests',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId: 'lsz-1',
          projectId: 'l8Uv7FzS',
          versionLabel: '2.21.1',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper'],
          gameVersions: ['26.2'],
          publishedAt: new Date(Date.UTC(2026, 4, 1)),
          file: cdn.file('lifestealz-2.21.1'),
          dependencies: [],
        },
      ],
    )
  }, 30_000)

  afterEach(() => {
    h.runtime.failBootWhen(() => null)
  })

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  /** A Lifesteal server: Paper with LifeStealZ, and a season of hearts on its volume. */
  const lifesteal = async () => {
    const owner = await h.user('Alex', 'plus')
    const { id } = await h.create(owner, { loader: 'paper', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    const add = { add: [{ projectId: 'l8Uv7FzS' }] }
    const plan = await h.app.mods.plan(owner, id, add)
    if (plan.kind !== 'ok') throw new Error(`Conflicts: ${JSON.stringify(plan.conflicts)}`)
    const before = await h.server(id)
    const shas = plan.mods.map((m) => m.artifact.sha512)
    await h.app.mods.apply(owner, id, add, shas, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    await mkdir(dirname(hearts(h, id)), { recursive: true })
    await writeFile(hearts(h, id), 'last season')
    await writeFile(hearts(h, id, 'config.yml'), 'startHearts: 10')
    return { owner, id }
  }

  test('a new season resets everyone’s hearts after a snapshot that keeps the old ones', async () => {
    const { owner, id } = await lifesteal()
    expect(await h.app.worldQueries.freshStart(owner, id)).toEqual({
      kind: 'season',
      name: 'Season 2',
      leaving: 'World',
      hearts: 10,
    })
    await startOver(h, owner, id)
    await expect(exists(hearts(h, id))).rejects.toThrow()
    expect(await readFile(hearts(h, id, 'config.yml'), 'utf8')).toBe('startHearts: 10')
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect((await h.app.worldQueries.list(owner, id)).map((w) => [w.name, w.active])).toEqual([
      ['World', false],
      ['Season 2', true],
    ])
    // Restoring the snapshot taken first brings back the season, hearts and all.
    const [snapshot] = (await listBackups(h.db, id)).filter((b) => b.trigger === 'pre_apply')
    await h.app.backups.restoreBackup(owner, id, snapshot?.id ?? '', randomUUID(), {
      withConfiguration: false,
    })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect(await readFile(hearts(h, id), 'utf8')).toBe('last season')
  }, 60_000)

  test('a new season that doesn’t start goes back to the last one, hearts and all', async () => {
    const { owner, id } = await lifesteal()
    const first = (await h.server(id)).activeWorldId
    h.runtime.failBootWhen((spec) => (spec.env.LEVEL === 'world-2' ? 'the world would not load' : null))
    await h.app.worlds.freshStart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.activeWorldId === first, 20_000)
    await h.settled(id, 20_000)
    expect(await readFile(hearts(h, id), 'utf8')).toBe('last season')
  }, 60_000)

  test('a new season needs the server running, to reset the hearts', async () => {
    const { owner, id } = await lifesteal()
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await expect(h.app.worlds.freshStart(owner, id, randomUUID())).rejects.toThrow('Start the server first')
    expect(await readFile(hearts(h, id), 'utf8')).toBe('last season')
    expect((await h.app.worldQueries.list(owner, id)).map((w) => w.name)).toEqual(['World'])
  }, 60_000)
})
