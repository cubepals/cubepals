// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' compatibility layer: the Via plugins every Paper server starts with, which are never
 * the owner's plugins, and the switch that takes them off at the next start.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { schema } from '@blockly/db'
import { protocolOf } from '../../minecraft/clients.ts'
import { VIABACKWARDS, VIAREWIND, VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { templateOf } from '../setups/templates.ts'
import { compatFor } from './service.ts'

let h: Harness
const cdn = new Cdn()

/** A Via plugin on the catalog, under its real project id, for every release Cubepals offers. */
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

describe.skipIf(!hasDatabase)('the Via plugins every Paper server starts with', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    via(VIAVERSION, 'ViaVersion')
    via(VIABACKWARDS, 'ViaBackwards')
    via(VIAREWIND, 'ViaRewind')
    expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  /** The Via plugins a server's start places, by name, from the spec it boots. */
  const placed = async (id: string) => {
    const { spec } = await h.app.specs.desired(h.db, await h.server(id))
    return (spec.env.BLOCKLY_JARS ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')[0])
  }

  /** A Smooth server, Paper with no plugins, made on Free. */
  const smooth = async (name: string) => {
    const owner = await h.user(name)
    const { templates } = await h.app.queries.createOptions(owner)
    expect(templates.find((template) => template.key === 'smooth')?.fits.allowed).toBe(true)
    const server = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }

  test('a Free Paper server gets ViaVersion and ViaBackwards, and stays a Free server with no plugins', async () => {
    const { owner, id } = await smooth('Fern')
    const server = await h.server(id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    // Not the owner's plugins: the revision, and so every plan rule, holds none.
    expect(revision.loader).toBe('paper')
    expect(revision.mods).toEqual([])
    const { spec } = await h.app.specs.desired(h.db, server)
    expect(spec.env.PLUGINS).toBe('')
    expect(await placed(id)).toEqual([
      expect.stringMatching(new RegExp(`^plugins/.*${VIAVERSION}`)),
      expect.stringMatching(new RegExp(`^plugins/.*${VIABACKWARDS}`)),
    ])
    // On the server's disk, placed as it started.
    const volume = h.runtime.machine(id)?.dir ?? ''
    const jars = (await h.app.specs.desired(h.db, server)).spec.env.BLOCKLY_JARS ?? ''
    for (const path of jars.split('\n').map((line) => line.split(' ')[0]))
      expect(existsSync(`${volume}/${path}`)).toBe(true)
    // Its page says who joins, with the switch, and lists no plugins.
    const view = await h.app.queries.get(owner, id)
    expect(view.joins).toEqual({ oldest: '1.9', newer: true, otherVersions: 'on' })
    expect(view.joinsNewer).toBe(true)
    expect((await h.app.accountQueries.overview(owner)).plan.key).toBe('free')
  }, 60_000)

  test('the Via plugins are not counted as plugins for what a plan allows', async () => {
    const owner = await h.user('Gale')
    // A Free account can make a plugin-free Paper server; one that carries plugins needs Plus.
    const { templates } = await h.app.queries.createOptions(owner)
    expect(templates.find((template) => template.key === 'smooth')?.fits.allowed).toBe(true)
    expect(templates.find((template) => template.key === 'lifesteal')?.fits).toMatchObject({ allowed: false })
    const preview = await h.app.queries.setupPreview(owner, { kind: 'template', key: 'smooth' })
    expect(preview).toMatchObject({ mods: [], joinsNewer: true })
  }, 30_000)

  test('switched off, they come off at the next start; switched back, they return', async () => {
    const { owner, id } = await smooth('Hale')
    const volume = h.runtime.machine(id)?.dir ?? ''
    const before = await placed(id)
    expect(before).toHaveLength(2)

    await h.app.revisions.changeOtherVersions(owner, id, 'off', randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await placed(id)).toEqual([])
    for (const path of before) expect(existsSync(`${volume}/${path}`)).toBe(false)
    expect((await h.app.queries.get(owner, id)).joins).toMatchObject({ newer: false, otherVersions: 'off' })

    await h.app.revisions.changeOtherVersions(owner, id, 'oldest', randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await placed(id)).toHaveLength(3)
    expect((await h.app.queries.get(owner, id)).joins).toEqual({
      oldest: '1.7.2',
      newer: true,
      otherVersions: 'oldest',
    })
  }, 60_000)

  test('Duels lets in 1.8 and 1.7 too, with ViaRewind', () => {
    expect(templateOf('duels')?.setup.settings.otherVersions).toBe('oldest')
  })

  test('only Paper has the choice', async () => {
    const owner = await h.user('Ivy')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect((await h.app.queries.get(owner, server.id)).joins?.otherVersions).toBeNull()
    expect(await placed(server.id)).toEqual([])
    await expect(h.app.revisions.changeOtherVersions(owner, server.id, 'off', randomUUID())).rejects.toThrow(
      'Only a Paper server',
    )
  }, 30_000)

  describe('on a server that sleeps instead of stopping', () => {
    afterEach(async () => {
      h.runtime.sleeps.on = false
      await h.app.setups.compat.refresh()
    })

    /** The route the edge gives a server: which players' games it takes. */
    const joins = async (slug: string) =>
      (await h.app.edge.routes()).routes.find((route) => route.hostname === `${slug}.play.test`)?.joins

    /** A Smooth server made before Cubepals had any Via plugin to place, put to sleep once it runs. */
    const madeBefore = async (name: string) => {
      h.runtime.sleeps.on = true
      await h.db.delete(schema.compatPlugins)
      const { owner, id } = await smooth(name)
      expect(await placed(id)).toEqual([])
      const { slug } = await h.server(id)
      const { gameVersion } = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
      return { owner, id, slug, protocol: protocolOf(gameVersion) ?? -1 }
    }

    const sleep = async (owner: UserActor, id: string) => {
      await h.app.servers.stop(owner, id, randomUUID(), 'idle')
      await h.until(id, 'stopped')
      await h.settled(id)
      expect(h.runtime.machine(id)?.state).toBe('suspended')
    }

    const wake = async (owner: UserActor, id: string) => {
      await h.app.servers.start(owner, id, randomUUID())
      await h.until(id, 'running')
      await h.settled(id)
    }

    /** Whether every Via plugin the server's spec places is on its disk. */
    const onDisk = async (id: string) => {
      const volume = h.runtime.machine(id)?.dir ?? ''
      const jars = await placed(id)
      return jars.length > 0 && jars.every((path) => existsSync(`${volume}/${path}`))
    }

    test('one made before the Via plugins existed has them on disk once it wakes', async () => {
      const { owner, id } = await madeBefore('Kit')
      await sleep(owner, id)
      await h.app.setups.compat.refresh()
      await wake(owner, id)
      expect(await placed(id)).toHaveLength(2)
      expect(await onDisk(id)).toBe(true)

      // Asleep again on what it now runs, it wakes as it slept, with them still in place.
      await sleep(owner, id)
      await wake(owner, id)
      expect(h.runtime.machine(id)?.state).toBe('running')
      expect(await onDisk(id)).toBe(true)
    }, 60_000)

    test('the edge takes the games of the Via plugins its run placed, not those it asks for', async () => {
      const { owner, id, slug, protocol } = await madeBefore('Lark')
      await h.app.setups.compat.refresh()
      // Running on a boot that placed none: only its own release joins until a boot places them.
      expect(await joins(slug)).toEqual({
        release: expect.any(String),
        protocol,
        oldest: protocol,
        newest: protocol,
      })
      // Asleep, it takes what its next wake places.
      await sleep(owner, id)
      expect(await joins(slug)).toMatchObject({ oldest: protocolOf('1.9') ?? -1 })
      expect((await joins(slug))?.newest).toBeUndefined()
      await wake(owner, id)
      expect(await onDisk(id)).toBe(true)
      expect(await joins(slug)).toMatchObject({ oldest: protocolOf('1.9') ?? -1 })
      expect((await joins(slug))?.newest).toBeUndefined()
    }, 60_000)
  })

  test('a Via plugin the owner runs as their own is not placed again', async () => {
    const { desiredRevisionId } = await h.server((await smooth('Jude')).id)
    const revision = await loadRevision(h.db, desiredRevisionId)
    const [own] = await compatFor(h.db, revision)
    if (own === undefined) throw new Error('No Via plugin was pinned')
    const { dir: _dir, ...theirs } = own
    const placedBeside = await compatFor(h.db, { ...revision, mods: [theirs] })
    expect(placedBeside.map((mod) => mod.name)).toEqual(['ViaBackwards'])
  }, 60_000)
})
