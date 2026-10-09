import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { CatalogProject, CatalogVersion } from '../../domain/mods/catalog.ts'
import { compareVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { zipOf } from '../../testing/uploads.ts'
import { loadRevision } from '../servers/persistence.ts'
import { tierFor } from './service.ts'

/**
 * Turning "what do you want to play?" into a server that boots (§15.6): the templates Blockly
 * offers, a server someone copies, and a modpack, which brings its own Minecraft version, its
 * own server type and its own mods.
 */
describe.skipIf(!hasDatabase)('setups', () => {
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

  /**
   * A pack file as the catalog publishes one: an index naming the newest release its version is
   * tagged with and the loader, as a real pack's own index does.
   */
  const packFile = (name: string, release: { id: string; loaders: string[]; gameVersions: string[] }) => {
    const minecraft = [...release.gameVersions].sort((a, b) => compareVersions(b, a))[0] ?? '26.3'
    const key = { fabric: 'fabric-loader', quilt: 'quilt-loader', neoforge: 'neoforge', forge: 'forge' }
    const loader = release.loaders.find((l): l is keyof typeof key => l in key) ?? 'fabric'
    return zipOf({
      'modrinth.index.json': packIndex(name, release.id, minecraft, { [key[loader]]: '1.0.0' }),
    })
  }

  /** A pack index, with `dependencies` for what it runs on. */
  const packIndex = (name: string, versionId: string, minecraft: string, loader: Record<string, string>) =>
    JSON.stringify({
      formatVersion: 1,
      game: 'minecraft',
      versionId,
      name,
      files: [],
      dependencies: { minecraft, ...loader },
    })

  /** A modpack on the catalog: one project, its versions newest first. */
  const publishPack = (
    projectId: string,
    name: string,
    releases: Array<{
      id: string
      loaders: string[]
      gameVersions: string[]
      environment?: string
      /** The pack file itself, where a test reads what is in it. */
      file?: Buffer
    }>,
    about: { categories?: string[]; environments?: string[] } = {},
  ) =>
    h.catalog.publishModpack(
      {
        projectId,
        slug: projectId,
        name,
        summary: `${name}, for tests`,
        iconUrl: null,
        environments: (about.environments ?? []) as CatalogProject['environments'],
        downloads: 1,
        categories: about.categories ?? [],
      },
      releases.map(
        (release, i): CatalogVersion => ({
          versionId: release.id,
          projectId,
          versionLabel: release.id,
          channel: 'release',
          state: 'listed',
          environment: (release.environment ?? 'client_and_server') as CatalogVersion['environment'],
          loaders: release.loaders,
          gameVersions: release.gameVersions,
          publishedAt: new Date(Date.UTC(2026, 0, 1 + releases.length - i)),
          file: cdn.file(`${projectId}-${release.id}`, release.file ?? packFile(name, release)),
          dependencies: [],
        }),
      ),
    )

  test('a handful of mods is still a small server, however heavy their jars are', () => {
    const jar = (name: string, megabytes: number): PinnedMod => ({
      source: { catalog: 'modrinth', projectId: name, versionId: `${name}-1` },
      name,
      versionLabel: '1',
      artifact: {
        ref: { kind: 'remote', url: `https://cdn.test/${name}.jar` },
        sha512: 'a'.repeat(128),
        sizeBytes: Math.round(megabytes * 1024 * 1024),
        fileName: `${name}.jar`,
      },
      environment: 'server',
      loaders: ['paper'],
      gameVersions: ['1.21.8'],
      origin: 'user',
      requiredBy: [],
    })
    // One plugin shipped as a big shaded jar: ordinary, and the smallest size runs it.
    expect(tierFor([jar('spark', 23)])).toBe('3g')
    expect(tierFor([])).toBe('3g')
    // Many mods, many megabytes: that is a pack, and it needs room.
    expect(tierFor(Array.from({ length: 40 }, (_, i) => jar(`mod-${i}`, 4)))).toBe('4g')
    // Past a light pack it wants four cores, which come with the large size.
    expect(tierFor(Array.from({ length: 80 }, (_, i) => jar(`mod-${i}`, 4)))).toBe('8g')
  })

  test('a template decides the release, the server type and the settings; nobody is asked', async () => {
    const owner = await h.user('Steve', 'plus')
    const preview = await h.app.queries.setupPreview(owner, { kind: 'template', key: 'smooth' })
    // "Smoother survival" is Paper, on the newest release Blockly offers that has a Paper build.
    expect(preview.loader).toBe('paper')
    expect(preview.modpack).toBeNull()
    expect(preview.mods).toEqual([])

    const server = await h.create(owner, { from: { kind: 'template', key: 'hardcore' } })
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.settings.difficulty).toBe('hard')
    expect(revision.loader).toBe('vanilla')
    // How it was made is kept, for knowing which ways to start people use.
    const [row] = await h.db
      .select({ from: schema.minecraftServers.createdFrom })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, server.id))
    expect(row?.from).toBe('template')
  }, 30_000)

  test('a template plays the release someone picks, to match their friends’ game; one not offered is refused', async () => {
    const owner = await h.user('Alex', 'plus')
    const newest = await h.app.queries.setupPreview(owner, { kind: 'template', key: 'survival' })
    const older = await h.app.queries.setupPreview(owner, {
      kind: 'template',
      key: 'survival',
      gameVersion: '1.21.1',
    })
    expect(older.gameVersion).toBe('1.21.1')
    expect(newest.gameVersion).not.toBe('1.21.1')
    const server = await h.create(owner, {
      from: { kind: 'template', key: 'creative', gameVersion: '1.21.1' },
    })
    expect((await loadRevision(h.db, server.desiredRevisionId)).gameVersion).toBe('1.21.1')
    await expect(
      h.app.queries.setupPreview(owner, { kind: 'template', key: 'survival', gameVersion: '1.2.5' }),
    ).rejects.toThrow('Cubepals doesn’t offer Minecraft 1.2.5.')
  }, 30_000)

  test('a pack that leaves mods for players to download by hand is turned away when it is picked', async () => {
    const owner = await h.user()
    // The shape of Better MC's Modrinth edition: Missing Mods Checker, and the list it reads.
    const byHand = Buffer.from(
      zipOf({
        'modrinth.index.json': packIndex('By Hand', 'bh-1', '26.3', { 'fabric-loader': '1.0.0' }),
        'overrides/mods/missingmodschecker.jar': 'a jar',
        'overrides/config/missing_mods_checker.json': JSON.stringify([
          { displayName: 'Balm' },
          { displayName: 'FTB Teams' },
        ]),
      }),
    )
    publishPack('by-hand', 'By Hand', [
      { id: 'bh-1', loaders: ['fabric'], gameVersions: ['26.3'], file: byHand },
    ])
    const refused = await h.app.queries.setupPreview(owner, { kind: 'modpack', projectId: 'by-hand' }).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(refused).toBe(
      'By Hand leaves 2 of its mods for each player to download by hand, which a server can’t do, so it can’t run as one.',
    )

    // Refused once, it leaves the default list, and its name finds it dimmed with the same words.
    const browsed = await h.app.queries.searchModpacks(owner, { text: '', offset: 0, limit: 50 })
    expect(browsed.map((hit) => hit.name)).not.toContain('By Hand')
    const [found] = await h.app.queries.searchModpacks(owner, { text: 'By Hand', offset: 0, limit: 10 })
    expect(found).toMatchObject({ name: 'By Hand', refusal: refused })

    // One nobody has picked is found out by the hourly look at the default list, and never shows.
    publishPack('by-hand-too', 'By Hand Too', [
      { id: 'bht-1', loaders: ['fabric'], gameVersions: ['26.3'], file: byHand },
    ])
    expect(await h.app.setups.checkBrowsed()).toBeGreaterThan(0)
    const after = await h.app.queries.searchModpacks(owner, { text: '', offset: 0, limit: 50 })
    expect(after.map((hit) => hit.name)).not.toContain('By Hand Too')
    // Checked within the day, it isn't read again.
    expect(await h.app.setups.unchecked(['by-hand-too'])).toEqual([])
  })

  test('a modpack brings its own version and server type, and the server runs the pack itself', async () => {
    publishPack('create-pack', 'Create: Above and Beyond', [
      { id: 'cab-2', loaders: ['neoforge'], gameVersions: ['1.21.1'] },
      { id: 'cab-1', loaders: ['neoforge'], gameVersions: ['1.20.1'] },
    ])
    const owner = await h.user('Alex', 'plus')
    const preview = await h.app.queries.setupPreview(owner, {
      kind: 'modpack',
      projectId: 'create-pack',
    })
    // The newest version of the pack, and what that version says it runs on. No question asked.
    // Everyone playing installs it too, and the preview says so.
    expect(preview.modpack).toMatchObject({
      name: 'Create: Above and Beyond',
      version: 'cab-2',
      environment: 'both',
    })
    expect(preview.gameVersion).toBe('1.21.1')
    expect(preview.loader).toBe('neoforge')
    // A pack that claims neither lightweight nor kitchen-sink takes the middle size, which is
    // where every pack in the capacity research actually sat.
    expect(preview.size.label).toBe('4 GB')

    const server = await h.create(owner, {
      from: { kind: 'modpack', projectId: 'create-pack' },
      partySize: '5',
    })
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.modpack).toMatchObject({ projectId: 'create-pack', versionId: 'cab-2' })
    expect(revision.mods).toEqual([])
    const [row] = await h.db
      .select({ from: schema.minecraftServers.createdFrom })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, server.id))
    expect(row?.from).toBe('modpack')

    // Everywhere it is shown, it is that exact version, got from the catalog itself: the owner's
    // overview, its Mods page, and the page its players open.
    const pack = {
      name: 'Create: Above and Beyond',
      version: 'cab-2',
      icon: null,
      page: 'https://catalog.test/project/create-pack/version/cab-2',
      file: revision.modpack?.artifact.ref.kind === 'remote' ? revision.modpack.artifact.ref.url : 'stored',
      app: 'catalog-app://version/cab-2',
      environment: 'both' as const,
    }
    expect((await h.app.queries.get(owner, server.id)).modpack).toEqual(pack)
    expect((await h.app.modQueries.list(owner, server.id)).modpack).toEqual(pack)
    expect((await h.app.sharingQueries.page(server.slug, owner))?.needs.modpack).toEqual(pack)

    // What the container is told: the pack, and nothing that would fight it.
    const { spec } = await h.app.specs.desired(h.db, await h.server(server.id))
    expect(spec.env.TYPE).toBe('MODRINTH')
    expect(spec.env.MODRINTH_MODPACK).toBeString()
    expect(spec.env.VERSION).toBe('1.21.1')
    // An empty mod list would have the image delete the pack's own mods.
    expect(spec.env.MODS).toBeUndefined()
    expect(spec.env.NEOFORGE_VERSION).toBeUndefined()

    // Its mods and Minecraft come with the pack: planning a mod or a version is refused as the
    // change would be, not accepted and then refused.
    const packOwned =
      'This server plays Create: Above and Beyond: its Minecraft and its mods come with the pack. Change the pack instead.'
    await expect(h.app.mods.plan(owner, server.id, { add: [{ projectId: 'sodium' }] })).rejects.toThrow(
      packOwned,
    )
    await expect(
      h.app.mods.planVersion(owner, server.id, { gameVersion: '26.3', loader: 'neoforge' }),
    ).rejects.toThrow(packOwned)
  }, 30_000)

  test('a pack’s own size follows what it says it is, and Free meets Plus at every pack', async () => {
    publishPack('light-pack', 'Light Pack', [{ id: 'lp-1', loaders: ['fabric'], gameVersions: ['26.3'] }], {
      categories: ['lightweight', 'optimization'],
    })
    publishPack('sink-pack', 'Sink Pack', [{ id: 'sp-1', loaders: ['fabric'], gameVersions: ['26.3'] }], {
      categories: ['kitchen-sink'],
    })
    publishPack('plain-pack', 'Plain Pack', [{ id: 'pp-1', loaders: ['fabric'], gameVersions: ['26.3'] }])

    // A free account plays plain Minecraft: every pack is offered, dimmed, with the one plan that
    // runs it, said the way choosing it would be refused, with no gigabytes in it.
    const owner = await h.user('Robin')
    const light = await h.app.queries.setupPreview(owner, { kind: 'modpack', projectId: 'light-pack' })
    expect(light.size).toMatchObject({ label: '3 GB', allowed: false, plan: 'plus' })
    expect(light.size.reason).toBe('Modpacks come with Plus.')
    const sink = await h.app.queries.setupPreview(owner, { kind: 'modpack', projectId: 'sink-pack' })
    expect(sink.size).toMatchObject({ label: '8 GB', allowed: false, reason: 'Modpacks come with Plus.' })
    const plain = await h.app.queries.setupPreview(owner, { kind: 'modpack', projectId: 'plain-pack' })
    expect(plain.size).toMatchObject({ label: '4 GB', allowed: false })

    // On Plus each takes the size its tags argue for, and every one of them runs.
    const payer = await h.user('Robin Plus', 'plus')
    for (const [pack, label] of [
      ['light-pack', '3 GB'],
      ['plain-pack', '4 GB'],
      ['sink-pack', '8 GB'],
    ] as const)
      expect(
        (await h.app.queries.setupPreview(payer, { kind: 'modpack', projectId: pack })).size,
      ).toMatchObject({
        label,
        allowed: true,
      })

    // Searching, every pack is listed; on Free each is marked with the very words choosing it
    // would be refused with, so the page can dim it before anyone clicks.
    const found = await h.app.queries.searchModpacks(owner, { text: 'Pack', offset: 0, limit: 20 })
    const fitOf = (name: string) => found.find((hit) => hit.name === name)?.fits
    for (const name of ['Light Pack', 'Sink Pack', 'Plain Pack'])
      expect(fitOf(name)).toEqual({ allowed: false, reason: 'Modpacks come with Plus.', plan: 'plus' })
  }, 30_000)

  test('the play cards put what the plan runs first; a search keeps the catalogue’s order', async () => {
    // Ranked this way by the catalogue: the heavy one first, as if it were the best match.
    publishPack('zeta-heavy', 'Zeta Heavy', [{ id: 'zh-1', loaders: ['fabric'], gameVersions: ['26.3'] }], {
      categories: ['kitchen-sink'],
    })
    publishPack('zeta-light', 'Zeta Light', [{ id: 'zl-1', loaders: ['fabric'], gameVersions: ['26.3'] }], {
      categories: ['lightweight'],
    })
    const owner = await h.user('Ari')

    // Searched by name, the catalogue's relevance stands: sorting by fit would bury what was
    // typed, and could lift an unrelated pack above it.
    const searched = await h.app.queries.searchModpacks(owner, { text: 'Zeta', offset: 0, limit: 20 })
    expect(searched.map((hit) => hit.name)).toEqual(['Zeta Heavy', 'Zeta Light'])

    // The play cards: what Free runs first, then what comes with Plus, each saying so.
    const { templates } = await h.app.queries.createOptions(owner)
    const firstDimmed = templates.findIndex((template) => !template.fits.allowed)
    expect(firstDimmed).toBeGreaterThan(0)
    expect(templates.slice(firstDimmed).every((template) => !template.fits.allowed)).toBe(true)
    const fitOf = (key: string) => templates.find((template) => template.key === key)?.fits
    expect(fitOf('survival')).toEqual({ allowed: true })
    expect(fitOf('smooth')).toEqual({ allowed: true })
    expect(fitOf('create')).toEqual({
      allowed: false,
      reason: 'Mods and plugins come with Plus.',
      plan: 'plus',
    })
    expect(fitOf('fabric')).toEqual({
      allowed: false,
      reason: 'Fabric servers come with Plus.',
      plan: 'plus',
    })

    // On Plus every card and every pack fits.
    const payer = await h.user('Ari Plus', 'plus')
    expect((await h.app.queries.createOptions(payer)).templates.every((t) => t.fits.allowed)).toBe(true)
    const browsed = await h.app.queries.searchModpacks(payer, { text: '', offset: 0, limit: 20 })
    expect(browsed.map((hit) => hit.name)).toContain('Zeta Heavy')
    expect(browsed.every((hit) => hit.fits.allowed)).toBe(true)
  }, 30_000)

  test('a pack made for a player’s own game is refused, and only listed when searched for', async () => {
    publishPack('client-pack', 'Client Pack', [{ id: 'cp-1', loaders: ['fabric'], gameVersions: ['26.3'] }], {
      environments: ['client_only'],
    })
    const owner = await h.user('Jo', 'plus')
    const refused = await h.app.queries
      .setupPreview(owner, { kind: 'modpack', projectId: 'client-pack' })
      .then(
        () => null,
        (error: Error) => error.message,
      )
    expect(refused).toBe("Client Pack is made for a player's own game, not for a server.")
    // Somebody who typed its name finds it, marked for what it is, rather than "nothing found".
    const searched = await h.app.queries.searchModpacks(owner, { text: 'Client Pack', offset: 0, limit: 10 })
    expect(searched.find((hit) => hit.name === 'Client Pack')?.runsOnServers).toBe(false)
    // It is never suggested.
    const browsed = await h.app.queries.searchModpacks(owner, { text: '', offset: 0, limit: 50 })
    expect(browsed.map((hit) => hit.name)).not.toContain('Client Pack')
  }, 30_000)

  test('a pack with a version for servers plays that one, and players join with plain Minecraft', async () => {
    // Sodium Plus's shape: its newest version is for players' games, and beside it is one made
    // for servers, which runs there on its own.
    publishPack(
      'speedy-plus',
      'Speedy Plus',
      [
        { id: 'sp-client-2', loaders: ['fabric'], gameVersions: ['26.3'], environment: 'client_only' },
        {
          id: 'sp-server-2',
          loaders: ['fabric'],
          gameVersions: ['26.3'],
          environment: 'dedicated_server_only',
        },
        { id: 'sp-client-1', loaders: ['fabric'], gameVersions: ['26.2'], environment: 'client_only' },
      ],
      { environments: ['client_only', 'dedicated_server_only'], categories: ['lightweight'] },
    )
    const owner = await h.user('Kit', 'plus')
    // The version a server installs is the one made for servers, never the newer one for players.
    const preview = await h.app.queries.setupPreview(owner, { kind: 'modpack', projectId: 'speedy-plus' })
    expect(preview.modpack).toMatchObject({ version: 'sp-server-2', environment: 'server' })
    // Asked for by a version made for players' games, it says so rather than blaming Minecraft.
    const byVersion = await h.app.queries
      .setupPreview(owner, { kind: 'modpack', projectId: 'speedy-plus', versionId: 'sp-client-2' })
      .then(
        () => null,
        (error: Error) => error.message,
      )
    expect(byVersion).toBe("That version of Speedy Plus is made for a player's own game, not for a server.")

    // Found by name, as a pack a server can be; not among the suggestions, whose downloads it
    // would only have from players' games.
    const searched = await h.app.queries.searchModpacks(owner, { text: 'Speedy', offset: 0, limit: 10 })
    expect(searched.find((hit) => hit.name === 'Speedy Plus')?.runsOnServers).toBe(true)
    const browsed = await h.app.queries.searchModpacks(owner, { text: '', offset: 0, limit: 50 })
    expect(browsed.map((hit) => hit.name)).not.toContain('Speedy Plus')

    // Made, it runs the server's version, and its page asks players for nothing but Minecraft.
    const made = await h.create(owner, { from: { kind: 'modpack', projectId: 'speedy-plus' } })
    const revision = await loadRevision(h.db, made.desiredRevisionId)
    expect(revision.modpack).toMatchObject({ versionId: 'sp-server-2', environment: 'server' })
    const page = await h.app.sharingQueries.page(made.slug, owner)
    expect(page?.needs).toEqual({ gameVersion: '26.3', modpack: null, loader: null, mods: [] })
  }, 30_000)

  test('what the preview says is what creating makes, whatever the party', async () => {
    publishPack('party-pack', 'Party Pack', [{ id: 'pk-1', loaders: ['fabric'], gameVersions: ['26.3'] }], {
      categories: ['lightweight'],
    })
    const owner = await h.user('Sky', 'plus')
    const from = { kind: 'modpack' as const, projectId: 'party-pack' }
    // A light pack on its own is the smallest size; a big party is what makes it bigger, and
    // the preview has to say the same thing the create does.
    expect((await h.app.queries.setupPreview(owner, from, '5')).size.label).toBe('3 GB')
    expect((await h.app.queries.setupPreview(owner, from, 'more')).size.label).toBe('8 GB')
    const made = await h.create(owner, { from, partySize: 'more' })
    expect(made.memoryTier).toBe('8g')
  }, 30_000)

  test('a modpack with nothing Blockly can run is refused in words, not in errors', async () => {
    publishPack('ancient', 'Ancient Pack', [{ id: 'old-1', loaders: ['forge'], gameVersions: ['1.7.10'] }])
    const owner = await h.user('Sam', 'plus')
    const refused = await h.app.queries.setupPreview(owner, { kind: 'modpack', projectId: 'ancient' }).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(refused).toContain('Ancient Pack')
  }, 30_000)

  test('the free plan is told a pack comes with Plus before anything is made, rather than failing later', async () => {
    publishPack('big-pack', 'Big Pack', [{ id: 'bp-1', loaders: ['fabric'], gameVersions: ['1.21.1'] }])
    const owner = await h.user('Robin')
    const preview = await h.app.queries.setupPreview(owner, { kind: 'modpack', projectId: 'big-pack' })
    // Said in the owner's terms: what, and which plan. No gigabytes, no machine talk.
    expect(preview.size).toMatchObject({ allowed: false, reason: 'Modpacks come with Plus.', plan: 'plus' })
    // Creating it anyway is refused in the same words, and nothing is made.
    const refused = await h.create(owner, { from: { kind: 'modpack', projectId: 'big-pack' } }).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(refused).toBe('Modpacks come with Plus.')
  }, 30_000)
})
