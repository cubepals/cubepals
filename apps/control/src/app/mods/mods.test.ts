import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { diskName } from '../../minecraft/jars.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { identity, type ModChange } from './service.ts'

// Mods end to end (§15.5): search, resolution through the catalog, the plan, the revision it applies.
describe.skipIf(!hasDatabase)('mods', () => {
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

  interface Release {
    id: string
    gameVersions?: string[]
    environment?: CatalogVersion['environment']
    requires?: string[]
  }
  /** A project on the catalog, its versions listed newest first, their files on the CDN. */
  const publish = (projectId: string, name: string, releases: Release[]) =>
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name,
        summary: `${name}, for tests`,
        iconUrl: null,
        // A project is wherever any of its versions runs, the way Modrinth adds them up.
        environments: [...new Set(releases.map((release) => release.environment ?? 'server_only'))],
        downloads: 1,
      },
      releases.map(
        (release, i): CatalogVersion => ({
          versionId: release.id,
          projectId,
          versionLabel: release.id,
          channel: 'release',
          state: 'listed',
          environment: release.environment ?? 'server_only',
          loaders: ['fabric'],
          gameVersions: release.gameVersions ?? ['26.3'],
          publishedAt: new Date(Date.UTC(2026, 0, 1 + releases.length - i)),
          file: cdn.file(`${projectId}-${release.id}`),
          dependencies: (release.requires ?? []).map((p) => ({
            projectId: p,
            versionId: null,
            kind: 'required',
          })),
        }),
      ),
    )

  const server = async (request: { loader?: 'fabric' | 'vanilla'; gameVersion?: string } = {}) => {
    const owner = await h.user('Steve', 'plus')
    const created = await h.create(owner, { loader: 'fabric', ...request })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id }
  }
  /** Plans a change, then applies exactly what the plan showed, and waits for it to land. */
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
  const pinned = async (id: string) =>
    (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).mods.map((m) => [
      m.name,
      m.versionLabel,
      m.origin,
      m.requiredBy,
    ])

  test('a mod that needs a newer Minecraft offers the move, and installs in the same change', async () => {
    publish('newer-only', 'Newer Only', [{ id: 'newer-1', gameVersions: ['26.3'] }])
    const { owner, id } = await server({ gameVersion: '26.2' })
    const add = { add: [{ projectId: 'newer-only' }] }

    // Refused, but not a dead end: Blockly says where it does run.
    const refused = await h.app.mods.plan(owner, id, add)
    expect(refused).toMatchObject({
      kind: 'conflicts',
      conflicts: [{ kind: 'no_fitting_version', mod: 'Newer Only' }],
      movesTo: { gameVersion: '26.3' },
    })

    // Accepting the move plans it there, and applying does both in one change.
    const planned = await h.app.mods.plan(owner, id, { ...add, moveTo: '26.3' })
    if (planned.kind !== 'ok') throw new Error('expected a plan on the newer release')
    const before = await h.server(id)
    await h.app.mods.apply(
      owner,
      id,
      { ...add, moveTo: '26.3' },
      planned.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect([revision.gameVersion, revision.mods.map((m) => m.name)]).toEqual(['26.3', ['Newer Only']])
  }, 40_000)

  test('search offers what fits the server, including to a world still on vanilla', async () => {
    publish('iris', 'Iris Shaders', [{ id: 'iris-1' }])
    publish('iris-old', 'Iris Legacy', [{ id: 'iris-old-1', gameVersions: ['1.21.8'] }])
    const { owner, id } = await server()
    const found = await h.app.mods.search(owner, id, { text: 'iris', offset: 0, limit: 20 })
    expect(found.hits.map((hit) => hit.name)).toEqual(['Iris Shaders'])
    // A vanilla world is offered the same mods: its owner never picks a server type, so the
    // search runs against the one Blockly would move it to.
    const vanilla = await server({ loader: 'vanilla' })
    const offered = await h.app.mods.search(vanilla.owner, vanilla.id, {
      text: 'iris',
      offset: 0,
      limit: 20,
    })
    expect(offered.hits.map((hit) => hit.name)).toEqual(['Iris Shaders'])
  })

  test('a mod only players’ games run is found by its name, never suggested', async () => {
    publish('sodium', 'Sodium', [{ id: 'sodium-1', environment: 'client_only' }])
    publish('lithium-suggested', 'Lithium Suggested', [{ id: 'lithium-suggested-1' }])
    const { owner, id } = await server()
    const browsing = await h.app.mods.search(owner, id, { text: '', offset: 0, limit: 20 })
    const suggested = browsing.hits.map((hit) => hit.name)
    expect(suggested).toContain('Lithium Suggested')
    expect(suggested).not.toContain('Sodium')
    // Searched for by name it is there, so it doesn't seem missing, and marked as not a server's.
    const named = await h.app.mods.search(owner, id, { text: 'sodium', offset: 0, limit: 20 })
    expect(named.hits.map((hit) => [hit.name, hit.runsOnServers])).toEqual([['Sodium', false]])
  })

  test('a vanilla world takes its first mod by moving to a server type that runs it', async () => {
    publish('lithium', 'Lithium', [{ id: 'lithium-1' }])
    const { owner, id } = await server({ loader: 'vanilla' })
    const plan = await change(owner, id, { add: [{ projectId: 'lithium' }] })
    expect(plan.kind === 'ok' && plan.added.map((m) => m.name)).toEqual(['Lithium'])

    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    // The world stays on its release and keeps its world; only the server type moves, and the
    // build that runs it is pinned in the same revision.
    expect(revision.gameVersion).toBe('26.3')
    expect(revision.loader).toBe('fabric')
    expect(revision.loaderVersion).not.toBeNull()
    expect(await pinned(id)).toEqual([['Lithium', 'lithium-1', 'user', []]])
    expect(await h.minecraft.jars(id)).toEqual(revision.mods.map((m) => diskName(m.artifact)).sort())
  }, 40_000)

  test('a mod comes with what it requires, shown before anything changes, then installed', async () => {
    publish('fabric-api', 'Fabric API', [{ id: 'fapi-2' }, { id: 'fapi-1' }])
    publish('sodium', 'Sodium', [{ id: 'sodium-1', requires: ['fabric-api'] }])
    const { owner, id } = await server()
    const before = (await h.server(id)).desiredRevisionId

    const plan = await h.app.mods.plan(owner, id, { add: [{ projectId: 'sodium' }] })
    expect(plan.kind === 'ok' && plan.added.map((m) => [m.name, m.origin])).toEqual([
      ['Fabric API', 'dependency'],
      ['Sodium', 'user'],
    ])
    // Planning wrote nothing but the catalog states it saw.
    expect((await h.server(id)).desiredRevisionId).toBe(before)
    const [cached] = await h.db
      .select()
      .from(schema.catalogProjects)
      .where(eq(schema.catalogProjects.projectId, 'sodium'))
    expect(cached?.state).toBe('approved')

    await change(owner, id, { add: [{ projectId: 'sodium' }] })
    expect(await pinned(id)).toEqual([
      ['Fabric API', 'fapi-2', 'dependency', ['Sodium']],
      ['Sodium', 'sodium-1', 'user', []],
    ])
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision.reason).toBe('mods_changed')
    expect(await h.minecraft.jars(id)).toEqual(revision.mods.map((m) => diskName(m.artifact)).sort())
  })

  test('removing a mod takes what only it required; upgrades move pinned versions only when asked', async () => {
    publish('lithium', 'Lithium', [{ id: 'lithium-1', requires: ['fabric-api'] }])
    publish('ferritecore', 'FerriteCore', [{ id: 'ferrite-1' }])
    const { owner, id } = await server()
    await change(owner, id, { add: [{ projectId: 'lithium' }, { projectId: 'ferritecore' }] })
    publish('ferritecore', 'FerriteCore', [{ id: 'ferrite-2' }, { id: 'ferrite-1' }])

    // Another change keeps what is pinned: FerriteCore stays on 1.
    await change(owner, id, { remove: ['lithium'] })
    expect(await pinned(id)).toEqual([['FerriteCore', 'ferrite-1', 'user', []]])

    const plan = await change(owner, id, { upgrade: 'all' })
    expect(plan.kind === 'ok' && plan.updated.map((u) => [u.from.versionLabel, u.to.versionLabel])).toEqual([
      ['ferrite-1', 'ferrite-2'],
    ])
    expect(await pinned(id)).toEqual([['FerriteCore', 'ferrite-2', 'user', []]])
  })

  test('players install only what their game needs, and never a loader for a mod they can skip', async () => {
    // Lithium's and Simple Voice Chat's own words: either side runs it, better on both.
    publish('speedy', 'Speedy', [{ id: 'speedy-1', environment: 'client_or_server_prefers_both' }])
    publish('voice', 'Voice', [{ id: 'voice-1', environment: 'client_or_server_prefers_both' }])
    // Create's: a player's game must have it to join.
    publish('gears', 'Gears', [{ id: 'gears-1', environment: 'client_and_server' }])
    const { owner, id } = await server()
    const { slug } = await h.server(id)
    const marked = async () =>
      (await h.app.modQueries.list(owner, id)).mods.map((mod) => [mod.name, mod.environment])

    // Nothing a player's game has to have: plain Minecraft joins, and nothing is marked for them.
    await change(owner, id, { add: [{ projectId: 'speedy' }, { projectId: 'voice' }] })
    expect(await marked()).toEqual([
      ['Speedy', 'server'],
      ['Voice', 'server'],
    ])
    expect((await h.app.sharingQueries.page(slug, owner))?.needs).toMatchObject({ loader: null, mods: [] })

    // One that it must have: players install the loader for it, and the others come along.
    const plan = await change(owner, id, { add: [{ projectId: 'gears' }] })
    expect(plan.kind === 'ok' && plan.added.map((mod) => [mod.name, mod.environment])).toEqual([
      ['Gears', 'both'],
    ])
    expect(await marked()).toEqual([
      ['Gears', 'both'],
      ['Speedy', 'both'],
      ['Voice', 'both'],
    ])
    const needs = (await h.app.sharingQueries.page(slug, owner))?.needs
    expect(needs?.loader?.label).toBe('Fabric')
    expect(needs?.mods.map((mod) => mod.name).sort()).toEqual(['Gears', 'Speedy', 'Voice'])
  })

  test('conflicts change nothing, and a plan the catalog has moved past is refused', async () => {
    publish('zoomify', 'Zoomify', [{ id: 'zoom-1', environment: 'client_only' }])
    publish('krypton', 'Krypton', [{ id: 'krypton-1' }])
    const { owner, id } = await server()
    expect(await h.app.mods.plan(owner, id, { add: [{ projectId: 'zoomify' }] })).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'client_only', mod: 'Zoomify', projectId: 'zoomify' }],
    })
    await expect(
      h.app.mods.apply(owner, id, { add: [{ projectId: 'zoomify' }] }, [], randomUUID()),
    ).rejects.toThrow("These mods can't run together: Zoomify.")

    const plan = await h.app.mods.plan(owner, id, { add: [{ projectId: 'krypton' }] })
    publish('krypton', 'Krypton', [{ id: 'krypton-2' }, { id: 'krypton-1' }])
    const shown = plan.kind === 'ok' ? plan.mods.map((m) => m.artifact.sha512) : []
    await expect(
      h.app.mods.apply(owner, id, { add: [{ projectId: 'krypton' }] }, shown, randomUUID()),
    ).rejects.toThrow('The mod catalog changed since you looked')
    expect(await pinned(id)).toEqual([])
  })

  test('a new game version takes every mod along, or names the one that cannot follow', async () => {
    publish('starlight', 'Starlight', [
      { id: 'starlight-26.3', gameVersions: ['26.3'] },
      { id: 'starlight-26.2', gameVersions: ['26.2'] },
    ])
    publish('c2me', 'C2ME', [{ id: 'c2me-26.2', gameVersions: ['26.2'] }])
    const { owner, id } = await server({ gameVersion: '26.2' })
    await change(owner, id, { add: [{ projectId: 'starlight' }] })

    const plan = await h.app.mods.planVersion(owner, id, { gameVersion: '26.3', loader: 'fabric' })
    if (plan.kind !== 'ok') throw new Error('expected a plan')
    expect(plan.updated.map((u) => [u.from.versionLabel, u.to.versionLabel])).toEqual([
      ['starlight-26.2', 'starlight-26.3'],
    ])
    await change(owner, id, { add: [{ projectId: 'c2me' }] })
    expect(await h.app.mods.planVersion(owner, id, { gameVersion: '26.3', loader: 'fabric' })).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'no_fitting_version', mod: 'C2ME', projectId: 'c2me' }],
    })
    await change(owner, id, { remove: ['c2me'] })

    const before = await h.server(id)
    await h.app.mods.changeVersion(
      owner,
      id,
      { gameVersion: '26.3', loader: 'fabric' },
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect([revision.gameVersion, revision.mods.map((m) => m.versionLabel)]).toEqual([
      '26.3',
      ['starlight-26.3'],
    ])
  })

  test('the catalog being down stops a change with nothing written', async () => {
    publish('noisium', 'Noisium', [{ id: 'noisium-1' }])
    const { owner, id } = await server()
    h.catalog.outage(true)
    try {
      await expect(h.app.mods.plan(owner, id, { add: [{ projectId: 'noisium' }] })).rejects.toThrow(
        "Modrinth isn't answering right now",
      )
    } finally {
      h.catalog.outage(false)
    }
    expect(await pinned(id)).toEqual([])
  })

  test('catalog-refresh: withheld at once, absent only after two refreshes, everything pinned followed', async () => {
    publish('moonlight', 'Moonlight', [{ id: 'moon-1' }])
    publish('spark', 'Spark', [{ id: 'spark-1' }])
    const { owner, id } = await server()
    await change(owner, id, { add: [{ projectId: 'moonlight' }, { projectId: 'spark' }] })
    const state = async (projectId: string) =>
      (
        await h.db
          .select()
          .from(schema.catalogProjects)
          .where(eq(schema.catalogProjects.projectId, projectId))
      )[0]?.state

    h.catalog.setProjectState('moonlight', 'withheld')
    h.catalog.setProjectState('spark', 'absent')
    const first = await h.app.catalog.refresh()
    expect(first.filter((t) => ['moonlight', 'spark'].includes(t.id))).toEqual([
      { catalog: 'modrinth', kind: 'project', id: 'moonlight', from: 'approved', to: 'withheld' },
    ])
    expect(await state('spark')).toBe('approved')
    await h.app.catalog.refresh()
    expect(await state('spark')).toBe('absent')

    // The server's list says so, and changing its mods now asks the owner first.
    const list = await h.app.modQueries.list(owner, id)
    expect(list.mods.filter((m) => m.revoked).map((m) => m.name)).toEqual(['Moonlight', 'Spark'])
    // Each catalog mod links to its page, as the catalog's adapter words it.
    expect(list.mods.find((m) => m.name === 'Spark')?.url).toBe('https://catalog.test/project/spark')
    const plan = await h.app.mods.plan(owner, id, {})
    expect(plan.kind === 'ok' && plan.revoked.map(identity)).toEqual(['moonlight', 'spark'])
    expect(await h.app.catalog.staleSince()).toBeNull()
  })
})
