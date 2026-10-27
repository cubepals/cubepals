// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who could join the server a world came from (`world-people.ts`), through the real reader and a
 * real store: its whitelist, operators and bans read and shown, nobody let in until its owner
 * chooses, and those they chose on the server made from it, or the one it was brought to.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MOST_WORLD_PEOPLE, type PeopleChoice } from '@blockly/contracts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { bringNewWorld, bringWorld, serverFolder } from '../../testing/world-imports.ts'
import { offlineUuid } from '../access/identity.ts'
import { readAccess } from '../access/persistence.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'
import { accessFrom, peopleOf } from './world-people.ts'

let h: Harness
const store = new MemoryStore()

beforeAll(async () => {
  if (!hasDatabase) return
  await store.start()
  h = await startHarness({ capabilities: { archives: store, billing: null } })
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h?.close()
  store.close()
})

const account = async (name: string) => normalizeUuid((await h.profiles.byName(name))?.uuid ?? '')

/**
 * A vanilla server's folder that let in Alex, by their account, and Steve and Ghost, by the UUIDs
 * an offline-mode server makes up; made Alex its operator; banned Griefer for good, and Latecomer
 * until a day long gone; and let in only its whitelist.
 */
async function privateServer(): Promise<Uint8Array> {
  h.profiles.unknown('Ghost')
  const files = await serverFolder('vanilla-1.21.11')
  const alex = await account('Alex')
  files['whitelist.json'] = utf8(
    JSON.stringify([
      { uuid: alex, name: 'Alex' },
      { uuid: offlineUuid('Steve'), name: 'Steve' },
      { uuid: offlineUuid('Ghost'), name: 'Ghost' },
    ]),
  )
  files['ops.json'] = utf8(
    JSON.stringify([{ uuid: alex, name: 'Alex', level: 4, bypassesPlayerLimit: false }]),
  )
  const ban = { created: '2026-01-01 00:00:00 +0000', source: 'Server' }
  files['banned-players.json'] = utf8(
    JSON.stringify([
      {
        ...ban,
        uuid: offlineUuid('Griefer'),
        name: 'Griefer',
        expires: 'forever',
        reason: 'Broke the spawn',
      },
      {
        ...ban,
        uuid: offlineUuid('Latecomer'),
        name: 'Latecomer',
        expires: '2026-02-01 00:00:00 +0000',
        reason: 'x',
      },
    ]),
  )
  const properties = new TextDecoder().decode(files['server.properties'])
  files['server.properties'] = utf8(properties.replace('white-list=false', 'white-list=true'))
  return zipBytes(files)
}

describe('what a choice lets in', () => {
  test('an operator at the level their server gave them, and a ban for as long as it had left', () => {
    const people = {
      whitelistOn: false,
      whitelist: [],
      operators: [{ uuid: 'mod', name: 'Mod', level: 2, bypassesPlayerLimit: true }],
      bans: [{ uuid: 'late', name: 'Late', reason: 'Spam', expiresAt: '2099-01-01 00:00:00 +0000' }],
      unknown: [],
    }
    const { entries } = accessFrom(people, {
      letIn: ['mod'],
      operators: ['mod'],
      keepBans: true,
      whitelistOn: false,
    })
    expect(entries.map((entry) => [entry.list, entry.player.name, entry.details])).toEqual([
      ['whitelist', 'Mod', {}],
      ['operator', 'Mod', { level: 2, bypassesPlayerLimit: true }],
      ['ban', 'Late', { reason: 'Spam', expiresAt: '2099-01-01 00:00:00 +0000' }],
    ])
  })
})

describe('a whitelist with nobody on it', () => {
  test('isn’t turned on: it would keep everyone out, the owner too', () => {
    const people = { whitelistOn: true, whitelist: [], operators: [], bans: [], unknown: [] }
    const none = accessFrom(people, { letIn: [], operators: [], keepBans: true, whitelistOn: true })
    expect(none).toEqual({ whitelistOn: false, entries: [] })
  })
})

describe('the names in a server’s files', () => {
  const read = (rows: unknown[]) => ({
    archive: { kept: new Map([['whitelist.json', new TextEncoder().encode(JSON.stringify(rows))]]) },
    holds: { properties: 'server.properties' },
    world: { folder: 'world/' },
  })

  test('one no player can have is left out, never sent to the console', async () => {
    const people = await peopleOf(read([{ uuid: offlineUuid('Alex'), name: 'Alex\nop Mallory' }]), false, {
      byName: async () => null,
    } as unknown as PlayerProfiles)
    expect(people?.whitelist).toEqual([])
    expect(people?.unknown).toEqual(['Alex\nop Mallory'])
  })

  test('an account goes by the name it has now, not an old one the file kept', async () => {
    const uuid = '0f5b4c4e-2f1d-4a5b-9c3e-7d6a5b4c3d2e'
    const profiles = { byUuid: async () => ({ uuid, name: 'NewName' }) } as unknown as PlayerProfiles
    const people = await peopleOf(read([{ uuid, name: 'OldName' }]), true, profiles)
    expect(people?.whitelist).toEqual([{ uuid, name: 'NewName' }])
  })
})

describe('a server with more players than one choice takes', () => {
  test('shows only as many as can be let in, whitelist first, then its other operators', async () => {
    const rows = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({ uuid: offlineUuid(`${prefix}${i}`), name: `${prefix}${i}` }))
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const read = {
      archive: {
        kept: new Map([
          ['whitelist.json', encode(rows('Wanda', MOST_WORLD_PEOPLE - 1))],
          ['ops.json', encode([...rows('Wanda', 1), ...rows('Oscar', 5)])],
        ]),
      },
      holds: { properties: 'server.properties' },
      world: { folder: 'world/' },
    }
    const people = await peopleOf(read, false, {} as PlayerProfiles)
    expect(people?.operators.map((p) => p.name)).toEqual(['Wanda0', 'Oscar0'])
    const shown = new Set([...(people?.whitelist ?? []), ...(people?.operators ?? [])].map((p) => p.uuid))
    expect(shown.size).toBe(MOST_WORLD_PEOPLE)
  })
})

describe('what a server’s files say of a player', () => {
  test('a level that isn’t one of Minecraft’s, and a ban’s end it can’t read, aren’t carried as they are', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const read = {
      archive: {
        kept: new Map([
          [
            'ops.json',
            encode([
              { uuid: offlineUuid('Moderator'), name: 'Moderator', level: 9 },
              { uuid: offlineUuid('Helper'), name: 'Helper', level: 2 },
            ]),
          ],
          [
            'banned-players.json',
            encode([{ uuid: offlineUuid('Griefer'), name: 'Griefer', expires: 'next week' }]),
          ],
        ]),
      },
      holds: { properties: 'server.properties' },
      world: { folder: 'world/' },
    }
    const people = await peopleOf(read, false, {} as PlayerProfiles)
    expect(people?.operators.map((p) => [p.name, p.level])).toEqual([
      ['Moderator', 4],
      ['Helper', 2],
    ])
    expect(people?.bans.map((p) => [p.name, p.expiresAt])).toEqual([['Griefer', null]])
  })
})

describe('a player whose account can’t be looked up', () => {
  test('fails the read, to be tried again, rather than being left out as nobody', async () => {
    const files = new Map([
      [
        'whitelist.json',
        new TextEncoder().encode(JSON.stringify([{ uuid: offlineUuid('Alex'), name: 'Alex' }])),
      ],
    ])
    const read = {
      archive: { kept: files },
      holds: { properties: 'server.properties' },
      world: { folder: 'world/' },
    }
    const down = {
      byName: async () => {
        throw new Error('Mojang answered 429')
      },
    } as unknown as PlayerProfiles
    await expect(peopleOf(read, true, down)).rejects.toThrow('Mojang answered 429')
  })
})

describe.skipIf(!hasDatabase)('the players of the server a world came from', () => {
  test('are shown by their accounts, and a name with none is said', async () => {
    const owner = await h.user('Quinn', 'plus')
    const ready = await bringNewWorld(h, owner, await privateServer(), 'private.zip')
    if (ready.status !== 'ready') throw new Error(`The import is ${ready.status}`)
    const [alex, steve, griefer] = (await Promise.all(['Alex', 'Steve', 'Griefer'].map(account))) as [
      string,
      string,
      string,
    ]
    expect(ready.people).toEqual({
      whitelistOn: true,
      whitelist: [
        { uuid: alex, name: 'Alex' },
        { uuid: steve, name: 'Steve' },
      ],
      operators: [{ uuid: alex, name: 'Alex', level: 4, bypassesPlayerLimit: false }],
      bans: [{ uuid: griefer, name: 'Griefer', reason: 'Broke the spawn', expiresAt: null }],
      unknown: ['Ghost'],
    })
    expect(ready.notes).toContain(
      'No Minecraft account is called Ghost, so they aren’t among its players to let in.',
    )
  }, 120_000)

  test('a server made from it lets in only those its owner chose, and keeps its bans', async () => {
    const owner = await h.user('Rowan', 'plus')
    const ready = await bringNewWorld(h, owner, await privateServer(), 'private.zip')
    if (ready.status !== 'ready') throw new Error(`The import is ${ready.status}`)
    const alex = await account('Alex')
    // Alex comes, not as an operator; Steve isn't chosen.
    const people: PeopleChoice = { letIn: [alex], operators: [], keepBans: true, whitelistOn: true }
    const chosen = await h.app.backups.newWorlds.choosePeople(owner, ready.importId, people)
    expect(chosen.status === 'ready' && chosen.chosen).toEqual(people)
    const server = await h.create(owner, { from: { kind: 'world', importId: ready.importId } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const { record } = await readAccess(h.db, server.id)
    expect(record.whitelistEnabled).toBe(true)
    expect(record.entries.map((e) => `${e.list} ${e.player.name} ${e.state}`).sort()).toEqual([
      'ban Griefer active',
      'whitelist Alex active',
    ])
    expect(await h.minecraft.file(server.id, 'whitelist.json')).toContain('Alex')
    expect(await h.minecraft.file(server.id, 'whitelist.json')).not.toContain('Steve')
    expect(await h.minecraft.file(server.id, 'banned-players.json')).toContain('Griefer')
  }, 120_000)

  test('a server made from it, its owner choosing nothing, lets nobody in and keeps its bans', async () => {
    const owner = await h.user('Tamsin', 'plus')
    const ready = await bringNewWorld(h, owner, await privateServer(), 'private.zip')
    if (ready.status !== 'ready') throw new Error(`The import is ${ready.status}`)
    expect(ready.chosen).toBeNull()
    const server = await h.create(owner, { from: { kind: 'world', importId: ready.importId } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const { record } = await readAccess(h.db, server.id)
    // Open, as a new server is: a whitelist with nobody on it would keep its owner out too.
    expect(record.whitelistEnabled).toBe(false)
    expect(record.entries.map((e) => `${e.list} ${e.player.name}`)).toEqual(['ban Griefer'])
  }, 120_000)

  test('brought to a server, lets in nobody until its owner chooses', async () => {
    const owner = await h.user('Sage', 'plus')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const view = await bringWorld(h, owner, server.id, await privateServer(), { fileName: 'private.zip' })
    if (view.status !== 'ready') throw new Error(`The import is ${view.status}`)
    expect(view.people?.whitelist.map((p) => p.name)).toEqual(['Alex', 'Steve'])
    expect((await readAccess(h.db, server.id)).record.entries).toEqual([])

    const alex = await account('Alex')
    const chosen = await h.app.backups.imports.chosenPeople(owner, server.id, view.importId, {
      letIn: [alex],
      operators: [alex],
      keepBans: false,
      whitelistOn: false,
    })
    await h.app.access.letIn(owner, server.id, chosen)
    await h.settled(server.id)
    const { record } = await readAccess(h.db, server.id)
    // Its whitelist stays as it was: its owner didn't turn it on.
    expect(record.whitelistEnabled).toBe(false)
    expect(record.entries.map((e) => `${e.list} ${e.player.name}`).sort()).toEqual([
      'operator Alex',
      'whitelist Alex',
    ])
  }, 120_000)
})
