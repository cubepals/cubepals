/**
 * Datapacks end to end: found and resolved like mods, kept apart from them on the server. A vanilla
 * world stays vanilla for one, and a plan that doesn't run them says which does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import type { ModChange } from './service.ts'

describe.skipIf(!hasDatabase)('datapacks', () => {
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

  const publish = (
    projectId: string,
    name: string,
    loaders: string[],
    environment: CatalogVersion['environment'],
  ) =>
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name,
        summary: name,
        iconUrl: null,
        environments: [environment],
        downloads: 1,
      },
      [
        {
          versionId: `${projectId}-1`,
          projectId,
          versionLabel: '1',
          channel: 'release',
          state: 'listed',
          environment,
          loaders,
          gameVersions: ['26.3'],
          publishedAt: new Date('2026-09-01'),
          file: cdn.file(projectId),
          dependencies: [],
        },
      ],
    )

  const change = async (owner: UserActor, id: string, requested: ModChange) => {
    const plan = await h.app.mods.plan(owner, id, requested)
    if (plan.kind !== 'ok') throw new Error(`Conflicts: ${JSON.stringify(plan.conflicts)}`)
    const before = await h.server(id)
    await h.app.mods.apply(
      owner,
      id,
      requested,
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    return plan
  }

  test('a vanilla world takes a datapack as it is, into its world, and keeps it when a mod moves it on', async () => {
    publish('manhunt', 'Manhunt', ['datapack'], 'unknown')
    publish('lithium', 'Lithium', ['fabric'], 'server_only')
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { loader: 'vanilla' })
    await h.until(id, 'running')
    await h.settled(id)
    const before = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)

    // Found by the search a vanilla world runs, beside mods.
    const found = await h.app.mods.search(owner, id, { text: 'manhunt', offset: 0, limit: 20 })
    expect(found.hits.map((hit) => hit.name)).toEqual(['Manhunt'])
    const plan = await change(owner, id, { add: [{ projectId: 'manhunt' }] })
    expect(plan.kind === 'ok' && plan.loader).toBe('vanilla')

    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect([revision.loader, revision.loaderVersion]).toEqual(['vanilla', before.loaderVersion])
    // It asks nothing of players, whatever its project declares.
    expect(revision.mods.map((m) => [m.name, m.environment])).toEqual([['Manhunt', 'server']])
    const view = await h.app.modQueries.list(owner, id)
    expect(view.mods.map((m) => [m.name, m.datapack, m.environment])).toEqual([['Manhunt', true, 'server']])
    const { spec } = await h.app.specs.desired(h.db, await h.server(id))
    // Fetched through the same endpoint as every jar.
    expect(spec.env.BLOCKLY_DATAPACKS).toContain('/runtime/v1/artifacts/')
    expect(spec.env.MODS).toBeUndefined()

    // A mod moves the world to a mod loader; the datapack stays a datapack, in the world.
    await change(owner, id, { add: [{ projectId: 'lithium' }] })
    const modded = await h.app.specs.desired(h.db, await h.server(id))
    expect(modded.revision.loader).toBe('fabric')
    expect(modded.spec.env.MODS?.split(',')).toHaveLength(1)
    expect(modded.spec.env.BLOCKLY_DATAPACKS).toBe(spec.env.BLOCKLY_DATAPACKS)
  }, 60_000)

  test('Free counts a datapack as a mod, and says so', async () => {
    publish('day-counter', 'Day Counter', ['datapack'], 'server_only')
    const owner = await h.user('Alex', 'free')
    const { id } = await h.create(owner, { loader: 'vanilla' })
    await h.until(id, 'running')
    await h.settled(id)
    const plan = await h.app.mods.plan(owner, id, { add: [{ projectId: 'day-counter' }] })
    if (plan.kind !== 'ok') throw new Error('Expected a plan')
    await expect(
      h.app.mods.apply(
        owner,
        id,
        { add: [{ projectId: 'day-counter' }] },
        plan.mods.map((m) => m.artifact.sha512),
        randomUUID(),
      ),
    ).rejects.toThrow('Datapacks come with Plus.')
  }, 40_000)
})
