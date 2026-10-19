// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files private configuration places on servers flagged official: laid over the revision's
 * files at a start, for those servers alone, whatever a revision holds at the same paths; never in
 * a revision as read, nor in a world download; and a deployment whose settings are missing or
 * unreadable still starts its servers, and says so to an admin.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../../config/load.ts'
import type { CarriedFile } from '../../domain/revision/carried.ts'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { downloaded } from '../../testing/downloads.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import type { Actor, UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { carriedFileLines } from './carried-files.ts'
import { noOfficialFiles, officialFilesOf, withCurrentOwnFiles } from './own-files.ts'
import { loadRevision } from './persistence.ts'

const run = promisify(execFile)

const PATH = 'plugins/Example/config.yml'
const OVERLAY = 'mode: official\n'
const SHARED = 'plugins/Example/shared.yml'
const sections = (own: Record<string, Record<string, string>> = {}) => ({
  '*': { [PATH]: OVERLAY, [SHARED]: 'shared: true\n' },
  ...own,
})
const named = { id: 'id-1', slug: 'slug-1' }
const encoded = (content: string) => Buffer.from(content).toString('base64')

const revision = (carried: CarriedFile[]): ServerRevision => ({
  id: 'r',
  serverId: 's',
  number: 1,
  gameVersion: '1.21.11',
  loader: 'paper',
  loaderVersion: '1',
  settings: defaultSettings({ name: 'Example', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: carried,
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
})

describe('placing official files over a revision', () => {
  test('with none, a revision comes back as it is', () => {
    const plain = revision([{ path: 'server-icon.png', content: 'x' }])
    expect(withCurrentOwnFiles(plain, noOfficialFiles.forStart(named))).toBe(plain)
    expect(withCurrentOwnFiles(plain, [])).toBe(plain)
  })

  test('they take the place of the revision’s own file at the same path, and nothing else moves', () => {
    const mine = revision([
      { path: PATH, content: 'mode: player\n' },
      { path: 'other.yml', content: 'kept' },
    ])
    const placed = withCurrentOwnFiles(mine, officialFilesOf(sections()).forStart(named)).files
    expect(placed.filter((file) => file.path === PATH)).toEqual([{ path: PATH, content: OVERLAY }])
    expect(placed.find((file) => file.path === 'other.yml')?.content).toBe('kept')
    expect(placed).toHaveLength(3)
    expect(mine.files).toHaveLength(2)
  })
})

describe('official files by server', () => {
  const contents = (files: readonly CarriedFile[]) =>
    Object.fromEntries(files.map((f) => [f.path, f.content]))

  test('the shared section reaches every server, and a server’s own section wins at a path', () => {
    const official = officialFilesOf(
      sections({ 'id-1': { [PATH]: 'by id\n' }, 'slug-2': { [PATH]: 'by slug\n' } }),
    )
    expect(contents(official.forStart(named))).toEqual({ [PATH]: 'by id\n', [SHARED]: 'shared: true\n' })
    expect(contents(official.forStart({ id: 'id-2', slug: 'slug-2' }))).toEqual({
      [PATH]: 'by slug\n',
      [SHARED]: 'shared: true\n',
    })
    expect(contents(official.forStart({ id: 'id-3', slug: 'slug-3' }))).toEqual(sections()['*'])
  })

  test('a download leaves out an official server’s paths, and a named server’s once it is not official', () => {
    const official = officialFilesOf(sections({ 'id-1': { 'plugins/Own/own.yml': 'own\n' } }))
    expect(official.leftOutOfDownload(named, true)).toEqual(new Set([PATH, SHARED, 'plugins/Own/own.yml']))
    expect(official.leftOutOfDownload(named, false)).toEqual(new Set([PATH, SHARED, 'plugins/Own/own.yml']))
    expect(official.leftOutOfDownload({ id: 'id-9', slug: 'slug-9' }, false).size).toBe(0)
    expect(official.leftOutOfDownload({ id: 'id-9', slug: 'slug-9' }, true)).toEqual(new Set([PATH, SHARED]))
  })
})

describe('official files in the configuration', () => {
  const env = {
    DEPLOYMENT_ID: 'local',
    DATABASE_URL: 'postgres://blockly:blockly@127.0.0.1:5432/blockly',
    WEB_CANONICAL_ORIGIN: 'http://localhost:3000',
    REALTIME_PUBLIC_URL: 'https://127.0.0.1:7443/',
    REALTIME_FALLBACK_URL: 'ws://127.0.0.1:7444/transport-io',
    REALTIME_TICKET_SECRET: 'ticket-secret-0123456789',
    PLAY_DOMAIN: 'play.localhost',
    REGIONS: 'local:This computer',
    RUNTIME_REGION_MAP: 'local:local',
    AUTH_SECRET: 'auth-secret-0123456789abcdef',
    SMTP_URL: 'smtp://127.0.0.1:1025',
    MAIL_FROM: 'Cubepals <hello@localhost>',
    EDGE_TOKEN: 'edge-token-0123456789',
    RUNTIME_SECRETS_KEY: 'runtime-secrets-0123456789',
    ARTIFACTS_RUNTIME_FACING_URL: 'http://host.docker.internal:4000',
  }

  test('are read from their sections; unset or unreadable settings load as none, with the reason', () => {
    const given = { '*': { [PATH]: OVERLAY }, 'slug-1': { [PATH]: 'a: 2\n' } }
    expect(loadConfig({ ...env, OFFICIAL_SERVER_FILES: JSON.stringify(given) }).officialServerFiles).toEqual({
      files: given,
      problem: null,
    })
    expect(loadConfig(env).officialServerFiles).toEqual({ files: {}, problem: null })
    const wrong = [
      '{not json',
      '[]',
      '{"a":1}',
      JSON.stringify({ [PATH]: OVERLAY }),
      JSON.stringify({ 'Not A Server': { [PATH]: 'x' } }),
      JSON.stringify({ 'a/b': { [PATH]: 'x' } }),
      JSON.stringify({ '': { [PATH]: 'x' } }),
      JSON.stringify({ '*': { '/etc/passwd': 'x' } }),
      JSON.stringify({ 'slug-1': { '../up': 'x' } }),
      JSON.stringify({ 'slug-1': { [PATH]: 1 } }),
    ]
    for (const value of wrong)
      expect(loadConfig({ ...env, OFFICIAL_SERVER_FILES: value }).officialServerFiles).toEqual({
        files: {},
        problem: 'invalid',
      })
  })
})

let h: Harness
let store: MemoryStore
const scratches: string[] = []
let admin: Actor

const withFiles = (options: Parameters<typeof startHarness>[0] = {}) =>
  startHarness({ capabilities: { archives: store, billing: null }, ...options })

/** The carried files a start of this server places, as the runtime is given them. */
const placedAtStart = async (id: string) =>
  carriedFileLines((await h.app.specs.desired(h.db, await h.server(id))).spec.env)

const official = async (id: string) => {
  await h.app.listings.markOfficial(admin, id, true, 'Cubepals runs it')
}

/** Sections the servers below add their ids to once they exist; the port reads them as each start asks. */
const SECTIONS: Record<string, Record<string, string>> = sections()

describe.skipIf(!hasDatabase)('official servers’ files', () => {
  beforeAll(async () => {
    store = new MemoryStore()
    await store.start()
    h = await withFiles({ officialServerFiles: { files: SECTIONS, problem: null } })
    admin = { kind: 'admin', userId: (await h.user('Admin')).userId }
    await h.db.insert(schema.platformAdmins).values({ userId: admin.userId, grantedBy: 'test' })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
    for (const dir of scratches) await rm(dir, { recursive: true, force: true })
  })

  const made = async (name: string): Promise<{ owner: UserActor; id: string; slug: string }> => {
    const owner = await h.user(name, 'plus')
    const created = await h.create(owner, { loader: 'vanilla' })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id, slug: (await h.server(created.id)).slug }
  }

  test('two official servers get different contents at one path, the shared section reaching both', async () => {
    const [one, two] = [await made('One'), await made('Two')]
    SECTIONS[one.id] = { [PATH]: 'by id\n' }
    SECTIONS[two.slug] = { [PATH]: 'by slug\n' }
    await official(one.id)
    await official(two.id)
    const first = await placedAtStart(one.id)
    const second = await placedAtStart(two.id)
    expect(first).toContain(`${PATH} ${encoded('by id\n')}`)
    expect(second).toContain(`${PATH} ${encoded('by slug\n')}`)
    for (const placed of [first, second]) {
      expect(placed).toContain(`${SHARED} ${encoded('shared: true\n')}`)
      expect(placed).not.toContain(encoded(OVERLAY))
    }
  }, 60_000)

  test('a server that is not official gets nothing, whatever its own revision or the settings hold', async () => {
    const ours = await made('Officer')
    const theirs = await made('Player')
    SECTIONS[theirs.id] = { [PATH]: 'named but not official\n' }
    // The player's own revision writes the same path: it stays theirs.
    const own = await loadRevision(h.db, (await h.server(theirs.id)).desiredRevisionId)
    await h.db
      .update(schema.serverRevisions)
      .set({ files: [...own.files, { path: PATH, content: 'mode: player\n' }] })
      .where(eq(schema.serverRevisions.id, own.id))
    await official(ours.id)
    expect(await placedAtStart(ours.id)).toContain(`${PATH} ${encoded(OVERLAY)}`)
    const player = await placedAtStart(theirs.id)
    expect(player).toContain(`${PATH} ${encoded('mode: player\n')}`)
    expect(player).not.toContain(encoded('named but not official\n'))
    expect(player).not.toContain(SHARED)
    // Unmarked, the server goes back to its own.
    await h.app.listings.markOfficial(admin, ours.id, false, 'Not ours any more')
    expect(await placedAtStart(ours.id)).not.toContain(encoded(OVERLAY))
  }, 60_000)

  test('they are in no revision, however it is read, and nothing restarts for them', async () => {
    const ours = await made('Keeper')
    const before = (await h.app.specs.desired(h.db, await h.server(ours.id))).driftDigest
    await official(ours.id)
    const server = await h.server(ours.id)
    const stored = await loadRevision(h.db, server.desiredRevisionId)
    expect(stored.files.map((file) => file.path)).not.toContain(PATH)
    const read = JSON.stringify(await h.app.queries.revisions(ours.owner, ours.id))
    expect(read).not.toContain(OVERLAY.trim())
    expect(read).not.toContain('shared.yml')
    expect((await h.app.specs.desired(h.db, server)).driftDigest).toBe(before)
    expect((await h.server(ours.id)).lifecycle.status).toBe('running')
  }, 60_000)

  /** The paths in a world download of this server, after it holds these files on its disk. */
  const downloadedPaths = async (server: { owner: UserActor; id: string }) => {
    for (const [path, text] of [
      ['world/built.txt', 'the castle'],
      [PATH, OVERLAY],
      [SHARED, 'shared: true\n'],
      ['plugins/Own/own.yml', 'own\n'],
      ['plugins/Example/mine.yml', 'owner’s own\n'],
    ] as const) {
      await mkdir(dirname(h.minecraft.path(server.id, path)), { recursive: true })
      await writeFile(h.minecraft.path(server.id, path), text)
    }
    await h.app.backups.createBackup(server.owner, server.id, randomUUID())
    await h.settled(server.id)
    const [snapshot] = (await listBackups(h.db, server.id)).filter((b) => b.trigger === 'manual')
    await h.app.backups.archiveBackup(server.owner, server.id, snapshot?.id ?? '', randomUUID())
    await h.settled(server.id)
    const [archive] = (await listBackups(h.db, server.id)).filter((b) => b.tier === 'archive')
    const dir = await mkdtemp(join(tmpdir(), 'blockly-official-'))
    scratches.push(dir)
    await mkdir(join(dir, 'out'))
    await writeFile(
      join(dir, 'world.tar.gz'),
      await downloaded(h.app, server.owner, server.id, archive?.id ?? ''),
    )
    await run('tar', ['-xzf', join(dir, 'world.tar.gz'), '-C', join(dir, 'out')])
    return (await readdir(join(dir, 'out'), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(join(dir, 'out'), join(entry.parentPath, entry.name)))
  }

  test('a world download leaves out the shared and the server’s own paths, official or not any more', async () => {
    const [official1, former, plain] = [await made('Down'), await made('Former'), await made('Plain')]
    SECTIONS[official1.id] = { 'plugins/Own/own.yml': 'own\n' }
    SECTIONS[former.slug] = { 'plugins/Own/own.yml': 'own\n' }
    await official(official1.id)
    const gone = [PATH, SHARED, 'plugins/Own/own.yml']
    for (const server of [official1, former]) {
      const paths = await downloadedPaths(server)
      expect(paths).toContain('world/built.txt')
      expect(paths).toContain('plugins/Example/mine.yml')
      for (const path of gone) expect(paths).not.toContain(path)
    }
    // Neither official nor named: what its disk holds is its owner's, whatever it is called.
    expect(await downloadedPaths(plain)).toEqual(expect.arrayContaining(gone))
  }, 150_000)
})

describe.skipIf(!hasDatabase)('official files that can’t be read', () => {
  let broken: Harness
  beforeAll(async () => {
    store = new MemoryStore()
    await store.start()
    broken = await withFiles({ officialServerFiles: { files: {}, problem: 'invalid' } })
  }, 30_000)
  afterAll(async () => {
    await broken.close()
    store.close()
  })

  test('an official server still starts with the public defaults, and an admin alert says why', async () => {
    const owner = await broken.user('Opal', 'plus')
    const created = await broken.create(owner, { loader: 'vanilla' })
    await broken.until(created.id, 'running')
    const adminId = (await broken.user('Boss')).userId
    await broken.db.insert(schema.platformAdmins).values({ userId: adminId, grantedBy: 'test' })
    await broken.app.listings.markOfficial({ kind: 'admin', userId: adminId }, created.id, true, 'ours')
    const spec = (await broken.app.specs.desired(broken.db, await broken.server(created.id))).spec
    expect(carriedFileLines(spec.env)).not.toContain(PATH)
    expect((await broken.app.alerts.sweep()).raised).toContain('official_files')
  }, 60_000)
})
