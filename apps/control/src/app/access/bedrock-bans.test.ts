// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Banning and pardoning a Bedrock player, on a running server and at boot. The server names a
 * player in `ban` and `pardon` through its name cache, then Mojang, which has no Bedrock player:
 * one is in the cache only once they have joined (Paper 26.2, `GameProfileArgument`,
 * `PlayerList.placeNewPlayer`), and the ban file is read only as the server starts. The fake
 * server does the same (`infra/fake/fake-minecraft/names.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { floodgateName, floodgateUuid } from '@blockly/contracts'
import { WAITS_FOR_JOIN, WAITS_FOR_START } from '../../domain/access/reconcile.ts'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'

describe.skipIf(!hasDatabase)('a Bedrock player banned and pardoned', () => {
  let h: Harness
  const geyser = new FakeGeyserMc()

  beforeAll(async () => {
    h = await startHarness({
      capabilities: {
        archives: null,
        billing: null,
        bedrock: { floodgateKey: Buffer.alloc(16, 7).toString('base64'), geyser },
      },
    })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /** A gamertag GeyserMC knows, and the player Floodgate logs them in as. */
  const bedrock = (gamertag: string, xuid: string) => {
    geyser.introduce(gamertag, xuid)
    return { uuid: floodgateUuid(xuid), name: floodgateName(gamertag) }
  }
  const running = async (name: string) => {
    const owner = await h.user(name)
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const banOf = async (owner: UserActor, id: string, uuid: string) =>
    (await h.app.queries.access(owner, id)).entries.find((e) => e.list === 'ban' && e.player.uuid === uuid)

  test('one who is on is turned out with the reason, kept out, and let back in when pardoned', async () => {
    const { owner, id } = await running('Ash')
    const player = bedrock('Dream', '2535400000000001')
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('joined')

    await h.app.access.add(owner, id, 'ban', '.Dream', 'griefing')
    await h.settled(id)
    expect(await banOf(owner, id, player.uuid)).toMatchObject({ state: 'active', error: null })
    expect(h.minecraft.kickedWith(id, player.uuid)).toBe('You are banned from this server. Reason: griefing')
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('banned')
    // In the server's file as it keeps it, by Floodgate's UUID and name.
    expect(JSON.parse((await h.minecraft.file(id, 'banned-players.json')) ?? '[]')).toEqual([
      expect.objectContaining({ uuid: player.uuid, name: '.Dream', reason: 'griefing' }),
    ])

    await h.app.access.remove(owner, id, 'ban', player.uuid)
    await h.settled(id)
    expect(await banOf(owner, id, player.uuid)).toBeUndefined()
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('joined')
  }, 60_000)

  test('one the server has not met: the ban waits, never shown as in force, and lands as they join', async () => {
    const { owner, id } = await running('Birch')
    const player = bedrock('Shroud', '2535400000000002')

    await h.app.access.add(owner, id, 'ban', '.Shroud', 'cheating')
    await h.settled(id)
    // The server can't name them yet: it says so, rather than rejecting the ban or claiming it.
    expect(await banOf(owner, id, player.uuid)).toMatchObject({ state: 'pending_add', error: WAITS_FOR_JOIN })
    expect(await h.minecraft.file(id, 'banned-players.json')).not.toContain(player.uuid)

    // As it would: they get in, and the next reading of who is on delivers the ban.
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('joined')
    await h.app.schedules.presenceSync()
    await h.settled(id)
    expect(await banOf(owner, id, player.uuid)).toMatchObject({ state: 'active', error: null })
    expect(h.minecraft.kickedWith(id, player.uuid)).toBe('You are banned from this server. Reason: cheating')
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('banned')
  }, 60_000)

  test('at boot, a waiting ban and pardon are written into the ban file and read as the server starts', async () => {
    const { owner, id } = await running('Cedar')
    const player = bedrock('Tfue', '2535400000000003')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.access.add(owner, id, 'ban', '.Tfue', 'spam')
    expect(await banOf(owner, id, player.uuid)).toMatchObject({ state: 'pending_add', error: null })

    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await banOf(owner, id, player.uuid)).toMatchObject({ state: 'active', error: null })
    expect(JSON.parse((await h.minecraft.file(id, 'banned-players.json')) ?? '[]')).toEqual([
      expect.objectContaining({ uuid: player.uuid, name: '.Tfue', reason: 'spam' }),
    ])
    // Never met, and kept out all the same: the server read the file as it started.
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('banned')

    // Pardoned while it runs: the server can't name a player it has only read from its file, so
    // the pardon waits for its next start, and the page says so.
    await h.app.access.remove(owner, id, 'ban', player.uuid)
    await h.settled(id)
    expect(await banOf(owner, id, player.uuid)).toMatchObject({
      state: 'pending_remove',
      error: WAITS_FOR_START,
    })
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('banned')

    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await banOf(owner, id, player.uuid)).toBeUndefined()
    expect(await h.minecraft.file(id, 'banned-players.json')).not.toContain(player.uuid)
    expect(await h.minecraft.bedrockLogin(id, player)).toBe('joined')
  }, 90_000)
})
