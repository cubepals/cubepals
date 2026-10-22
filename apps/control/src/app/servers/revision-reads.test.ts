// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A revision read takes only the columns it names: the SQL it sends lists them and no others, and
 * what comes back is as small as what was asked for, though the revision holds a large file and a
 * long list of mods. The comparison of two revisions by their digests gives the answer the whole
 * rows give.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPool, type Db, schema } from '@blockly/db'
import { drizzle } from 'drizzle-orm/node-postgres'
import { describeChanges, type ServerRevision } from '../../domain/revision/revision.ts'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'
import { listRevisions, loadRevision } from './persistence.ts'
import {
  loadChangeFacts,
  loadRevisionCard,
  loadRevisionFields,
  revisionHistory,
  summariesOf,
  WITHOUT_FILES,
} from './revision-reads.ts'

const BIG = 'option: value # a documented setting\n'.repeat(5000)

const mod = (n: number) => ({
  source: { catalog: 'modrinth', projectId: `p${n}`, versionId: `v${n}` },
  name: `Mod ${n}`,
  versionLabel: '1.0.0',
  artifact: {
    ref: { kind: 'remote', url: `https://cdn.example/mod-${n}.jar` },
    sha512: String(n).padStart(128, 'a'),
    sizeBytes: 1234,
    fileName: `mod-${n}.jar`,
  },
  environment: 'both',
  loaders: ['fabric'],
  gameVersions: ['1.21.4'],
  origin: 'user',
  requiredBy: [],
})

/** A server with three revisions, each holding a large file, and the ids of the revisions. */
async function seed(db: Db): Promise<{ serverId: string; ids: string[] }> {
  const ids: string[] = []
  await db
    .insert(schema.users)
    .values({ id: 'owner', name: 'Owner', email: 'owner@example.test', emailVerified: true })
  const [server] = await db
    .insert(schema.minecraftServers)
    .values({
      ownerId: 'owner',
      name: 'Reads',
      slug: 'reads',
      regionKey: 'local',
      memoryTier: 'small',
      status: 'stopped',
      createIdempotencyKey: 'reads',
      inviteCode: 'reads',
    })
    .returning({ id: schema.minecraftServers.id })
  const serverId = server?.id ?? ''
  const settings = {
    difficulty: 'normal',
    defaultGameMode: 'survival',
    pvp: true,
    viewDistance: 10,
    simulationDistance: 10,
    maxPlayers: 10,
    motd: 'Hi',
    spawnProtection: 0,
    onlineMode: true,
  }
  const made = [
    { number: 1, mods: [mod(1), mod(2)], files: [{ path: 'plugins/Plug/config.yml', content: BIG }] },
    {
      number: 2,
      mods: [mod(1), mod(3)],
      files: [{ path: 'plugins/Plug/config.yml', content: `${BIG}more\n` }],
    },
    {
      number: 3,
      mods: [mod(1), mod(3)],
      files: [{ path: 'plugins/Plug/config.yml', content: `${BIG}more\n` }],
    },
  ]
  for (const { number, mods, files } of made) {
    const [row] = await db
      .insert(schema.serverRevisions)
      .values({
        serverId,
        number,
        gameVersion: '1.21.4',
        loader: 'fabric',
        loaderVersion: '0.16.0',
        settings: { ...settings, motd: `Hi ${number}` } as never,
        mods: mods as never,
        modpack: null,
        files,
        reason: 'created',
        createdBy: 'user:owner',
      })
      .returning({ id: schema.serverRevisions.id })
    ids.push(row?.id ?? '')
  }
  return { serverId, ids }
}

/** The changes between every two of the server's revisions, said from their facts and from the whole rows. */
async function compareBothWays(db: Db, serverId: string, ids: string[]): Promise<void> {
  const whole = await listRevisions(db, serverId, 10)
  const { desired, entries } = await revisionHistory(db, serverId, ids[2] ?? '', 10)
  expect(entries.map((r) => r.number)).toEqual([3, 2, 1])
  for (let i = 0; i < whole.length; i++)
    for (let j = 0; j < whole.length; j++) {
      const x = entries[i]
      const y = entries[j]
      if (x === undefined || y === undefined) throw new Error('the history is short')
      expect(describeChanges(x, y)).toEqual(
        describeChanges(whole[i] as ServerRevision, whole[j] as ServerRevision),
      )
    }
  expect(describeChanges(desired, entries[2] as never)).toEqual(
    describeChanges(whole[0] as ServerRevision, whole[2] as ServerRevision),
  )
  // The changed file and the changed mod are among what it says, not nothing.
  expect(describeChanges(entries[2] as never, entries[0] as never)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: 'files', changed: ['Plug settings'] }),
      expect.objectContaining({ field: 'mods', added: ['Mod 3'], removed: ['Mod 2'] }),
    ]),
  )
}

describe.skipIf(!hasDatabase)('revision reads', () => {
  let drop: () => Promise<void>
  let pool: ReturnType<typeof createPool>
  let caught: string[] = []
  let sent: unknown[][] = []
  let db: ReturnType<typeof drizzle<typeof schema>>
  let ids: string[] = []
  let serverId = ''

  beforeAll(async () => {
    const fresh = await freshDatabase()
    drop = fresh.drop
    pool = createPool(fresh.url, 1)
    db = drizzle(pool, {
      schema,
      logger: {
        logQuery: (query, params) => {
          caught.push(query)
          sent.push(params)
        },
      },
    })
    ;({ serverId, ids } = await seed(db))
  })

  afterAll(async () => {
    await pool.end()
    await drop()
  })

  /** The SQL of the one query `run` sends. */
  async function sqlOf(run: () => Promise<unknown>): Promise<string> {
    caught = []
    await run()
    expect(caught).toHaveLength(1)
    return caught[0] ?? ''
  }

  test('a field read selects the columns named and no others', async () => {
    const query = await sqlOf(async () => {
      const read = await loadRevisionFields(db, ids[0] ?? '', ['gameVersion', 'settings'])
      expect(Object.keys(read).sort()).toEqual(['gameVersion', 'settings'])
      expect(read.settings.motd).toBe('Hi 1')
    })
    expect(query).toContain('"game_version"')
    expect(query).toContain('"settings"')
    for (const left of ['"files"', '"mods"', '"modpack"', '"acknowledged_revoked"'])
      expect(query).not.toContain(left)
  })

  test('a read without files leaves the files column out, and the rest matches the whole row', async () => {
    const whole = await loadRevision(db, ids[0] ?? '')
    const query = await sqlOf(async () => {
      const read = await loadRevisionFields(db, ids[0] ?? '', WITHOUT_FILES)
      expect(Object.keys(read)).not.toContain('files')
      const { files: _, ...rest } = whole
      expect(read).toEqual(rest)
    })
    expect(query).not.toContain('"files"')
  })

  test('a card names each mod and carries nothing more of it', async () => {
    const query = await sqlOf(async () => {
      const card = await loadRevisionCard(db, ids[0] ?? '')
      expect(card.mods).toEqual([
        { source: mod(1).source, name: 'Mod 1' },
        { source: mod(2).source, name: 'Mod 2' },
      ])
      expect(Object.keys(card).sort()).toEqual(
        ['gameVersion', 'id', 'loader', 'loaderVersion', 'modpack', 'mods', 'settings'].sort(),
      )
    })
    expect(query).not.toContain('"files"')
    expect(query).not.toMatch(/select [^)]*"server_revisions"\."mods"\s*,/)
  })

  test('summaries list the names of the mods without the mods', async () => {
    const query = await sqlOf(async () => {
      const found = await summariesOf(db, [ids[0] ?? '', ids[1] ?? ''])
      expect(found.get(ids[1] ?? '')).toEqual({
        id: ids[1] ?? '',
        number: 2,
        gameVersion: '1.21.4',
        loader: 'fabric',
        modNames: ['Mod 1', 'Mod 3'],
      })
    })
    expect(query).not.toContain('"files"')
  })

  test('the facts of a revision hold its files by digest, so a large file costs a few bytes', async () => {
    const facts = await loadChangeFacts(db, ids[0] ?? '')
    expect(facts.files).toHaveLength(1)
    expect(facts.files[0]?.content.length).toBeLessThan(100)
    expect(JSON.stringify(facts).length).toBeLessThan(2_000)
  })

  test('comparing revisions by their facts says what comparing whole rows says', () =>
    compareBothWays(db, serverId, ids))

  test('the mods are read once for each list that differs, not once for each revision', async () => {
    sent = []
    caught = []
    await revisionHistory(db, serverId, ids[2] ?? '', 10)
    // Revisions 2 and 3 hold the same mods, and the desired one is the third: two lists, two ids.
    const mods = caught.findIndex((query) => query.includes('jsonb_array_elements') && query.includes('in ('))
    expect(caught).toHaveLength(2)
    expect(sent[mods]).toHaveLength(2)
  })

  test('a desired revision older than the page is read on its own', async () => {
    const { desired, entries } = await revisionHistory(db, serverId, ids[0] ?? '', 1)
    expect(entries.map((r) => r.number)).toEqual([3])
    expect(desired.mods.map((m) => m.name)).toEqual(['Mod 1', 'Mod 2'])
  })

  test('a missing revision is an error, as it is for the whole read', async () => {
    const none = '00000000-0000-4000-8000-000000000000'
    await expect(loadRevisionFields(db, none, ['settings'])).rejects.toThrow(`Revision ${none} is missing`)
    await expect(loadRevisionCard(db, none)).rejects.toThrow(`Revision ${none} is missing`)
    await expect(loadChangeFacts(db, none)).rejects.toThrow(`Revision ${none} is missing`)
  })
})
