// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Server requests preserve normalization, deliberate request identities and validation boundaries. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { ADDRESS_MAX_LENGTH, ADDRESS_MIN_LENGTH, DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH } from './limits.ts'
import { oneLine, plainLines } from './plain-text.ts'
import * as server from './server.ts'
import { OWN_ICON_MAX_BYTES } from './server-list.ts'

const serverId = crypto.randomUUID()
const requestId = crypto.randomUUID()
const base = { serverId, requestId, version: 0 }
const settings = {
  difficulty: 'normal',
  defaultGameMode: 'survival',
  pvp: false,
  viewDistance: 8,
  simulationDistance: 6,
  maxPlayers: 5,
  motd: 'Welcome',
  spawnProtection: 0,
  keepInventory: false,
}

test('server references, deliberate power requests and invitations reject malformed identities', () => {
  expect(server.ServerId.parse(serverId)).toBe(serverId)
  expect(server.ServerRef.parse({ serverId })).toEqual({ serverId })
  expect(server.PowerInput.parse({ serverId, requestId })).toEqual({ serverId, requestId })
  expect(server.DeleteServerInput.parse({ serverId, confirmName: '' })).toEqual({ serverId, confirmName: '' })
  for (const value of ['', 'bad', 12, null]) {
    expect(server.ServerId.safeParse(value).success).toBe(false)
    expect(server.ServerRef.safeParse({ serverId: value }).success).toBe(false)
    expect(server.PowerInput.safeParse({ serverId, requestId: value }).success).toBe(false)
    expect(server.DeleteServerInput.safeParse({ serverId, confirmName: value }).success).toBe(
      typeof value === 'string',
    )
  }
  expect(server.InviteCode.parse(' ABCD23456789 ')).toBe('abcd23456789')
  for (const value of [
    'abcd2345678',
    'abcd234567899',
    'abcd23456780',
    'abcd23456781',
    'abcd2345678l',
    'abcd2345678!',
  ])
    expect(server.InviteCode.safeParse(value).success).toBe(false)
})

test('administrative actions require a trimmed, bounded reason and their own confirmation', () => {
  for (const schema of [
    server.MaintenanceStopInput,
    server.AdminStartInput,
    server.AdminTrashInput,
    server.AdminUntrashInput,
  ]) {
    const input = { serverId, requestId, confirmName: 'My world', reason: ' Maintenance ' }
    expect(schema.parse(input)).toMatchObject({ serverId, reason: 'Maintenance' })
    expect(schema.safeParse({ ...input, reason: 'x'.repeat(500) }).success).toBe(true)
    for (const reason of ['', ' ', 'x'.repeat(501), null])
      expect(schema.safeParse({ ...input, reason }).success).toBe(false)
    expect(schema.safeParse({ ...input, serverId: 'bad' }).success).toBe(false)
  }
  expect(server.AdminStartInput.safeParse({ serverId, reason: 'Maintenance' }).success).toBe(false)
  expect(server.AdminTrashInput.safeParse({ serverId, reason: 'Maintenance' }).success).toBe(false)
})

test('address suggestions and changes normalize text while enforcing their different bounds', () => {
  const name = '  My\nworld  '
  expect(server.SuggestAddressInput.parse({ name, slug: ' MAPLE ', serverId })).toEqual({
    name: oneLine(name).trim(),
    slug: 'maple',
    serverId,
  })
  expect(server.SuggestAddressInput.parse({ name: '' })).toEqual({ name: '' })
  expect(
    server.SuggestAddressInput.safeParse({
      name: 'x'.repeat(NAME_MAX_LENGTH),
      slug: 'x'.repeat(ADDRESS_MAX_LENGTH),
    }).success,
  ).toBe(true)
  for (const patch of [
    { name: 'x'.repeat(NAME_MAX_LENGTH + 1) },
    { slug: 'x'.repeat(ADDRESS_MAX_LENGTH + 1) },
    { serverId: 'bad' },
  ])
    expect(server.SuggestAddressInput.safeParse({ name: 'World', ...patch }).success).toBe(false)
  expect(server.ChangeAddressInput.parse({ serverId, slug: ' MAPLE ' })).toEqual({ serverId, slug: 'maple' })
  for (const size of [ADDRESS_MIN_LENGTH, ADDRESS_MAX_LENGTH])
    expect(server.ChangeAddressInput.safeParse({ serverId, slug: 'a'.repeat(size) }).success).toBe(true)
  for (const size of [ADDRESS_MIN_LENGTH - 1, ADDRESS_MAX_LENGTH + 1])
    expect(server.ChangeAddressInput.safeParse({ serverId, slug: 'a'.repeat(size) }).success).toBe(false)
})

test('settings validate types and integral values before the service applies gameplay bounds', () => {
  expect(server.ServerSettingsInput.parse(settings)).toMatchObject({
    difficulty: 'normal',
    pvp: false,
    maxPlayers: 5,
  })
  for (const key of ['viewDistance', 'simulationDistance', 'maxPlayers', 'spawnProtection']) {
    for (const value of [-1, 0, 1])
      expect(server.ServerSettingsInput.safeParse({ ...settings, [key]: value }).success).toBe(true)
    for (const value of [0.5, '5', null])
      expect(server.ServerSettingsInput.safeParse({ ...settings, [key]: value }).success).toBe(false)
  }
  for (const patch of [
    { difficulty: 'unknown' },
    { defaultGameMode: 'unknown' },
    { pvp: 'yes' },
    { motd: 'x'.repeat(201) },
  ])
    expect(server.ServerSettingsInput.safeParse({ ...settings, ...patch }).success).toBe(false)
  expect(server.ServerSettingsInput.safeParse({ ...settings, motd: 'x'.repeat(200) }).success).toBe(true)
  for (const difficulty of server.DIFFICULTIES)
    expect(server.ServerSettingsInput.safeParse({ ...settings, difficulty }).success).toBe(true)
  for (const defaultGameMode of server.GAME_MODES)
    expect(server.ServerSettingsInput.safeParse({ ...settings, defaultGameMode }).success).toBe(true)
})

test('every configuration request retains concurrency, acknowledgement and restart choices', () => {
  const requests = [
    [server.ChangeSettingsInput, { settings }],
    [server.ChangeAuthenticationInput, { onlineMode: false }],
    [server.ChangeOtherVersionsInput, { otherVersions: 'off' }],
    [server.ChangeBedrockInput, { bedrock: false }],
    [server.ChangeVersionInput, { gameVersion: '1.21', loader: 'paper', expected: [] }],
    [server.ResizeInput, { partySize: '5' }],
    [server.RollbackInput, { revisionId: crypto.randomUUID() }],
  ] as const
  for (const [schema, fields] of requests) {
    expect(schema.parse({ ...base, ...fields })).toMatchObject(base)
    for (const when of ['now', 'empty'])
      for (const acknowledgeRevoked of [true, false])
        expect(schema.parse({ ...base, ...fields, when, acknowledgeRevoked })).toMatchObject({
          when,
          acknowledgeRevoked,
        })
    for (const patch of [
      { serverId: 'bad' },
      { requestId: 'bad' },
      { version: -1 },
      { version: 0.5 },
      { when: 'later' },
      { acknowledgeRevoked: 'yes' },
    ])
      expect(schema.safeParse({ ...base, ...fields, ...patch }).success).toBe(false)
  }
  expect(server.ChangeAuthenticationInput.safeParse({ ...base, onlineMode: 'yes' }).success).toBe(false)
  expect(server.ChangeBedrockInput.safeParse({ ...base, bedrock: 'yes' }).success).toBe(false)
  expect(server.ResizeInput.safeParse({ ...base, partySize: 'unknown' }).success).toBe(false)
  expect(server.RollbackInput.safeParse({ ...base, revisionId: 'bad' }).success).toBe(false)
  for (const otherVersions of server.OTHER_VERSIONS)
    expect(server.ChangeOtherVersionsInput.parse({ ...base, otherVersions })).toEqual({
      ...base,
      otherVersions,
    })
  expect(server.ChangeOtherVersionsInput.safeParse({ ...base, otherVersions: 'unknown' }).success).toBe(false)
})

test('version changes validate exact hashes, bounded game versions and optional Paper selection', () => {
  const hash = createHash('sha512').update('a resolved artifact').digest('hex')
  const input = { ...base, gameVersion: ' 1.21 ', loader: 'paper' as const, expected: [hash] }
  expect(server.ChangeVersionInput.parse(input)).toEqual({ ...input, gameVersion: '1.21' })
  for (const onPaper of [true, false])
    expect(server.ChangeVersionInput.parse({ ...input, onPaper })).toMatchObject({ onPaper })
  for (const patch of [
    { gameVersion: '' },
    { gameVersion: ' ' },
    { gameVersion: 'x'.repeat(21) },
    { loader: 'unknown' },
    { onPaper: 'yes' },
    { expected: ['x'.repeat(128)] },
    { expected: [hash.toUpperCase()] },
    { expected: [hash.slice(1)] },
    { expected: [hash + 'a'] },
    { expected: Array(401).fill(hash) },
  ])
    expect(server.ChangeVersionInput.safeParse({ ...input, ...patch }).success).toBe(false)
  expect(
    server.ChangeVersionInput.safeParse({
      ...input,
      gameVersion: 'x'.repeat(20),
      expected: Array(400).fill(hash),
    }).success,
  ).toBe(true)
  for (const loader of server.LOADERS)
    expect(server.ChangeVersionInput.safeParse({ ...input, loader }).success).toBe(true)
})

test('identity edits normalize names and descriptions and distinguish omitted and cleared pictures', () => {
  const name = ' My\nworld ',
    description = ' A world\r\nfor friends '
  expect(
    server.SaveIdentityInput.parse({
      serverId,
      name,
      description,
      icon: 'grass',
      tags: ['survival'],
      picture: 'YQ==',
    }),
  ).toEqual({
    serverId,
    name: oneLine(name).trim(),
    description: plainLines(description).trim(),
    icon: 'grass',
    tags: ['survival'],
    picture: 'YQ==',
  })
  expect(server.SaveIdentityInput.parse({ serverId })).toEqual({ serverId })
  expect(server.SaveIdentityInput.parse({ serverId, icon: null, picture: null })).toEqual({
    serverId,
    icon: null,
    picture: null,
  })
  expect(
    server.SaveIdentityInput.safeParse({
      serverId,
      name: 'x'.repeat(NAME_MAX_LENGTH),
      description: 'x'.repeat(DESCRIPTION_MAX_LENGTH),
      tags: Array(5).fill('survival'),
      picture: Buffer.alloc(OWN_ICON_MAX_BYTES).toString('base64'),
    }).success,
  ).toBe(true)
  for (const patch of [
    { name: ' ' },
    { name: 'x'.repeat(NAME_MAX_LENGTH + 1) },
    { description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) },
    { icon: 'unknown' },
    { tags: ['unknown'] },
    { tags: Array(6).fill('survival') },
    { picture: 'not base64!' },
    { picture: Buffer.alloc(OWN_ICON_MAX_BYTES + 3).toString('base64') },
  ])
    expect(server.SaveIdentityInput.safeParse({ serverId, ...patch }).success).toBe(false)
})

test('public server choices remain compatible with saved worlds and request payloads', () => {
  expect(server.SERVER_STATUSES).toEqual([
    'provisioning',
    'stopped',
    'starting',
    'running',
    'stopping',
    'updating',
    'restoring',
    'relocating',
    'failed',
    'deleted',
    'purged',
    'storing',
    'stored',
  ])
  expect(server.STOP_REASONS).toEqual([
    'user',
    'idle',
    'policy',
    'entitlement',
    'crash',
    'maintenance',
    'session_cap',
    'hours',
    'unpaid',
    'daily',
    'free_hours',
  ])
  expect(server.LOADERS).toEqual(['vanilla', 'paper', 'fabric', 'quilt', 'neoforge', 'forge'])
  expect(server.PLAY_STYLES).toEqual(['survival', 'creative'])
  expect(server.PARTY_SIZES).toEqual(['5', '10', '20', '50', 'more'])
  expect(server.SERVER_ICONS).toEqual([
    'grass',
    'stone',
    'planks',
    'water',
    'diamond',
    'redstone',
    'torch',
    'chest',
    'heart',
  ])
  expect(server.PLAY_ICONS).toEqual([
    'survival',
    'creative',
    'hardcore',
    'smooth',
    'create',
    'lifesteal',
    'manhunt',
    'skyblock',
    'oneblock',
    'rpg',
    'duels',
    'arcade',
    'modpack',
    'ownpack',
  ])
  expect(server.BLOCKLY_ICON).toBe('blockly')
  expect(server.SERVER_TAGS).toEqual([
    'survival',
    'creative',
    'modded',
    'plugins',
    'hardcore',
    'peaceful',
    'pvp',
    'building',
    'technical',
    'adventure',
    'roleplay',
    'minigames',
    'family-friendly',
  ])
})

test('public operation choices remain compatible with stored progress and revisions', () => {
  expect(server.OPERATION_STEPS).toEqual([
    'queued',
    'allocating',
    'waiting_for_room',
    'storage',
    'compute',
    'booting',
    'resuming',
    'starting',
    'loading_world',
    'verifying',
    'access',
    'saving',
    'stopping',
    'rolling_back',
  ])
  expect(server.OPERATION_KINDS).toEqual([
    'provision',
    'start',
    'stop',
    'restart',
    'apply',
    'relocate',
    'backup',
    'archive',
    'restore',
    'access_sync',
    'prune_worlds',
    'decommission',
    'purge',
    'store',
    'unstore',
  ])
  expect(server.CHANGE_KINDS).toEqual(['pack', 'version', 'mods', 'world', 'settings'])
  expect(server.DIFFICULTIES).toEqual(['peaceful', 'easy', 'normal', 'hard'])
  expect(server.GAME_MODES).toEqual(['survival', 'creative', 'adventure', 'spectator'])
  expect(server.OTHER_VERSIONS).toEqual(['off', 'on', 'oldest'])
  expect(server.REVISION_REASONS).toEqual([
    'created',
    'mods_changed',
    'settings_changed',
    'version_changed',
    'rollback',
    'restore',
  ])
  for (const [schema, choices] of [
    [server.Loader, server.LOADERS],
    [server.PlayStyle, server.PLAY_STYLES],
    [server.PartySize, server.PARTY_SIZES],
    [server.ServerIcon, server.SERVER_ICONS],
    [server.ServerTag, server.SERVER_TAGS],
  ] as const) {
    for (const choice of choices) expect(schema.parse(choice)).toBe(choice)
    expect(schema.safeParse('unknown').success).toBe(false)
  }
})

test('settling waiting changes requires a deliberate request and an explicit action', () => {
  for (const settle of ['now', 'cancel'] as const)
    expect(server.SettleWaitingInput.parse({ serverId, requestId, settle })).toEqual({
      serverId,
      requestId,
      settle,
    })
  for (const patch of [{ serverId: 'bad' }, { requestId: 'bad' }, { settle: 'later' }])
    expect(
      server.SettleWaitingInput.safeParse({ serverId, requestId, settle: 'now', ...patch }).success,
    ).toBe(false)
})
