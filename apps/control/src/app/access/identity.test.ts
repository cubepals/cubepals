// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who a player is to a server, Bedrock players included: how a typed name becomes the UUID and name a
 * server keeps.
 */

import { describe, expect, test } from 'bun:test'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import { FakeProfiles } from '../../infra/fake/fake-profiles.ts'
import { accessCommand } from '../../minecraft/access.ts'
import { identityFor, keyedFor, namedBy, offlineUuid } from './identity.ts'

describe('who a player is to a server', () => {
  test('a server that does not verify accounts derives the player from the exact name', () => {
    // Each of these is what a real server wrote or logged for that name (2026-09-19, 2026-09-23):
    // vanilla 26.1's `list uuids`, and the whitelist, operator and ban files of vanilla 26.1 and
    // Paper 1.21.8 in offline mode.
    expect(offlineUuid('PresenceBot')).toBe('2289dfb4-69e8-34dd-94a2-8862994e2feb')
    expect(offlineUuid('BotOne')).toBe('9d235a47-ec7d-3184-8776-7263a6ae7d5c')
    expect(offlineUuid('OpBot')).toBe('b6a1b65e-f37d-32c1-9852-69a39a550592')
    expect(offlineUuid('NewGuy')).toBe('1d93c198-06e3-3b59-8cd5-087d7de1d56f')
    // Capitals are part of the name: to such a server these are two different players.
    expect(offlineUuid('newguy')).not.toBe(offlineUuid('NewGuy'))
  })

  test('the name is enough without verification; with it, the account decides', async () => {
    const profiles = new FakeProfiles()
    profiles.unknown('NoAccountHere')
    expect(await identityFor('NoAccountHere', false, profiles, null)).toEqual({
      uuid: offlineUuid('NoAccountHere'),
      name: 'NoAccountHere',
    })
    expect(await identityFor('NoAccountHere', true, profiles, null)).toBeNull()
    const verified = await identityFor('Steve', true, profiles, null)
    expect(verified?.uuid).not.toBe(offlineUuid('Steve'))
  })

  test('a server that does not verify accounts takes only a Java name as its own player', async () => {
    const profiles = new FakeProfiles()
    const geyser = new FakeGeyserMc()
    // A gamertag nobody knows, with a space, would reach the server's commands as its first word.
    expect(await identityFor('Pixel Pal', false, profiles, geyser)).toBeNull()
    expect(await identityFor('Pixel Pal', false, profiles, null)).toBeNull()
    expect(await identityFor('ab', false, profiles, geyser)).toBeNull()
    expect(await identityFor('.Pixel Pal', false, profiles, geyser)).toBeNull()
    geyser.introduce('Pixel Pal', '2535400000000000')
    expect((await identityFor('Pixel Pal', false, profiles, geyser))?.name).toBe('.Pixel_Pal')
  })

  test('no name that reaches a command has a space in it', async () => {
    const profiles = new FakeProfiles()
    const geyser = new FakeGeyserMc()
    geyser.introduce('Pixel Pal', '2535400000000000')
    for (const typed of ['Pixel Pal', '.Pixel Pal', 'Steve Alex', ' .Pixel  Pal ', 'Unknown One'])
      for (const onlineMode of [true, false]) {
        const player = await identityFor(typed, onlineMode, profiles, geyser)
        const command =
          player === null
            ? []
            : [accessCommand({ type: 'op', player }), accessCommand({ type: 'whitelist_add', player })]
        for (const line of command) expect(line.replace(/^(op|whitelist add) /, '')).not.toContain(' ')
      }
  })

  test('an identity says which kind of server it was made for', async () => {
    const profiles = new FakeProfiles()
    const account = (await identityFor('Steve', true, profiles, null)) ?? { uuid: '', name: '' }
    const derived = { uuid: offlineUuid('Steve'), name: 'Steve' }
    expect(keyedFor(account, true)).toBe(true)
    expect(keyedFor(account, false)).toBe(false)
    expect(keyedFor(derived, false)).toBe(true)
    expect(keyedFor(derived, true)).toBe(false)
  })
})

describe('a Bedrock player to a server', () => {
  // The UUID and name Floodgate gave a Bedrock player whose XUID was 2535400000000000, as measured.
  const XUID = '2535400000000000'
  const FLOODGATE_UUID = '00000000-0000-0000-0009-01eed05d1000'

  test('a gamertag typed with the dot Floodgate gives is the player Floodgate logs in', async () => {
    const geyser = new FakeGeyserMc()
    geyser.introduce('Pixel Pal', XUID)
    const player = await identityFor('.Pixel Pal', true, new FakeProfiles(), geyser)
    expect(player).toEqual({ uuid: FLOODGATE_UUID, name: '.Pixel_Pal' })
    // Offline-mode servers log the same player in, by the same UUID.
    expect(await identityFor('.Pixel Pal', false, new FakeProfiles(), geyser)).toEqual(player)
  })

  test('a name no Minecraft account has is looked up as a gamertag, and a Java account comes first', async () => {
    const geyser = new FakeGeyserMc()
    geyser.introduce('Pixel', XUID)
    const profiles = new FakeProfiles()
    profiles.unknown('Pixel')
    expect((await identityFor('Pixel', true, profiles, geyser))?.uuid).toBe(FLOODGATE_UUID)
    geyser.introduce('Steve', XUID)
    expect((await identityFor('Steve', true, new FakeProfiles(), geyser))?.uuid).not.toBe(FLOODGATE_UUID)
  })

  test('a gamertag nobody knows is no player, and without a lookup none is found', async () => {
    expect(await identityFor('.Nobody', true, new FakeProfiles(), new FakeGeyserMc())).toBeNull()
    expect(await identityFor('.Pixel', false, new FakeProfiles(), null)).toBeNull()
    expect(await identityFor('.', true, new FakeProfiles(), new FakeGeyserMc())).toBeNull()
  })

  test('a Bedrock player belongs to a server of either kind', () => {
    const player = { uuid: FLOODGATE_UUID, name: '.Pixel' }
    expect(keyedFor(player, true)).toBe(true)
    expect(keyedFor(player, false)).toBe(true)
  })

  test('an undotted gamertag on a server that does not check accounts is the Bedrock player', async () => {
    const geyser = new FakeGeyserMc()
    geyser.introduce('Pixel Pal', XUID)
    geyser.introduce('PixelPal', XUID)
    const profiles = new FakeProfiles()
    // A gamertag with a space can't be a Java name; one without it is taken for a Java player's
    // only while an account has it.
    expect((await identityFor('Pixel Pal', false, profiles, geyser))?.uuid).toBe(FLOODGATE_UUID)
    profiles.unknown('PixelPal')
    expect((await identityFor('PixelPal', false, profiles, geyser))?.uuid).toBe(FLOODGATE_UUID)
    // Someone who is only a Java name still gets what they always did.
    expect(await identityFor('Steve', false, new FakeProfiles(), geyser)).toEqual({
      uuid: offlineUuid('Steve'),
      name: 'Steve',
    })
  })

  test('a typed name is the player already known by it, a dotted gamertag included', () => {
    const player = { uuid: FLOODGATE_UUID, name: '.Pixel_Pal' }
    for (const typed of ['.Pixel Pal', '.pixel_pal', 'Pixel Pal'])
      expect(namedBy(player, typed, true)).toBe(true)
    // A name a Java account could have is not taken for the Bedrock player's.
    expect(namedBy({ uuid: FLOODGATE_UUID, name: '.Pixel' }, 'Pixel', true)).toBe(false)
    expect(namedBy({ uuid: FLOODGATE_UUID, name: '.Pixel' }, '.Pixel', true)).toBe(true)
    expect(namedBy({ uuid: offlineUuid('Steve'), name: 'Steve' }, 'steve', false)).toBe(false)
    expect(namedBy({ uuid: offlineUuid('Steve'), name: 'Steve' }, 'steve', true)).toBe(true)
  })
})
