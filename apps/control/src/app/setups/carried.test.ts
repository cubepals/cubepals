/**
 * A template that carries files Cubepals wrote and puts a plugin's jar in a folder of its own, as
 * a server made from it runs on the stand-in runtime: both arrive with the first start, both stay
 * through a later change of the server's plugins, and a copy of the server carries both.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { TEMPLATES, type Template } from './templates.ts'

const ADDONS = 'plugins/BentoBox/addons'
const HEARTS = 'startHearts: 7\nmaxHearts: 12\n'

/** Template-shaped, and only for this file: a game mode in BentoBox's folder, and a plugin's settings. */
const FIXTURE: Template = {
  key: 'test-carried',
  title: 'Islands with hearts',
  blurb: 'For tests.',
  icon: null,
  setup: {
    loader: 'paper',
    mods: [
      { catalog: 'modrinth', projectId: 'bentobox' },
      { catalog: 'modrinth', projectId: 'aoneblock', dir: ADDONS },
      { catalog: 'modrinth', projectId: 'lifestealz' },
    ],
    files: [{ path: 'plugins/LifeStealZ/config.yml', content: HEARTS }],
    settings: { defaultGameMode: 'survival' },
    world: { levelType: 'minecraft:normal', hardcore: false },
  },
}

describe.skipIf(!hasDatabase)('a setup that carries files', () => {
  let h: Harness
  const cdn = new Cdn()

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    ;(TEMPLATES as Template[]).push(FIXTURE)
  }, 30_000)

  afterAll(async () => {
    ;(TEMPLATES as Template[]).splice(TEMPLATES.indexOf(FIXTURE), 1)
    await h.close()
    cdn.close()
  })

  /** A Paper plugin on the catalog, for every release Cubepals offers, its versions newest first. */
  const publish = (projectId: string, name: string, ids: string[]) =>
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name,
        summary: `${name}, for tests`,
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      ids.map(
        (id, i): CatalogVersion => ({
          versionId: id,
          projectId,
          versionLabel: id,
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper'],
          gameVersions: offeredVersions().map((offered) => offered.id),
          publishedAt: new Date(Date.UTC(2026, 0, 1 + ids.length - i)),
          file: cdn.file(`${projectId}-${id}`),
          dependencies: [],
        }),
      ),
    )

  const addons = (volume: string) =>
    readdirSync(`${volume}/${ADDONS}`).filter((name) => name.endsWith('.jar'))

  test('the files and the folder come with the server, stay through a change, and come with a copy', async () => {
    publish('bentobox', 'BentoBox', ['bentobox-1'])
    publish('aoneblock', 'AOneBlock', ['aoneblock-1'])
    publish('lifestealz', 'LifeStealZ', ['lifestealz-1'])
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner, { from: { kind: 'template', key: FIXTURE.key } })
    await h.until(server.id, 'running')
    await h.settled(server.id)

    const first = await loadRevision(h.db, server.desiredRevisionId)
    expect(first.files).toEqual([{ path: 'plugins/LifeStealZ/config.yml', content: HEARTS }])
    expect(first.mods.map((m) => [m.name, m.dir])).toEqual([
      ['AOneBlock', ADDONS],
      ['BentoBox', undefined],
      ['LifeStealZ', undefined],
    ])
    const volume = h.runtime.machine(server.id)?.dir ?? ''
    expect(readFileSync(`${volume}/plugins/LifeStealZ/config.yml`, 'utf8')).toBe(HEARTS)
    expect(addons(volume)).toEqual([expect.stringMatching(/-aoneblock-aoneblock-1\.jar$/)])
    // The image's own plugins folder has the rest, and not the game mode.
    expect(readdirSync(`${volume}/plugins`).filter((name) => name.includes('aoneblock'))).toEqual([])

    // A newer AOneBlock: the change keeps it in BentoBox's folder, and the files with it.
    publish('aoneblock', 'AOneBlock', ['aoneblock-2', 'aoneblock-1'])
    const change = { upgrade: ['aoneblock'] }
    const plan = await h.app.mods.plan(owner, server.id, change)
    if (plan.kind !== 'ok') throw new Error('expected a plan')
    const before = await h.server(server.id)
    await h.app.mods.apply(
      owner,
      server.id,
      change,
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(
      server.id,
      (s) => s.lifecycle.status === 'running' && s.version > before.version + 1,
      20_000,
    )
    await h.settled(server.id, 20_000)
    const upgraded = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    expect(upgraded.mods.find((m) => m.name === 'AOneBlock')?.dir).toBe(ADDONS)
    expect(upgraded.files).toEqual(first.files)
    expect(addons(volume)).toEqual([expect.stringMatching(/-aoneblock-aoneblock-2\.jar$/)])
    expect(existsSync(`${volume}/plugins/LifeStealZ/config.yml`)).toBe(true)

    // A copy plays the same: its files, and its game mode where BentoBox reads it.
    const copy = await h.create(owner, { from: { kind: 'server', slug: server.slug } })
    const copied = await loadRevision(h.db, copy.desiredRevisionId)
    expect(copied.files).toEqual(first.files)
    expect(copied.mods.find((m) => m.name === 'AOneBlock')?.dir).toBe(ADDONS)
  }, 60_000)
})
