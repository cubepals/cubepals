// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Moderation is enabled by actual plugin identity and only controls its own files and players. */
import { expect, test } from 'bun:test'
import type { PinnedMod } from '../domain/mods/artifact.ts'
import {
  CHATSENTINEL,
  filtersChat,
  giveCommands,
  HELPER_GROUP_FILE,
  helperCommand,
  isModerationFile,
  LIBERTYBANS,
  LUCKPERMS,
  moderationFiles,
  parseHelpers,
  pinsProject,
  punishCommand,
  runsModeration,
} from './moderation.ts'

const uuid = 'abcdef01-2345-6789-abcd-ef0123456789'
const pin = (projectId: string): PinnedMod => ({
  source: { catalog: 'modrinth', projectId, versionId: 'version' },
  name: 'Plugin',
  versionLabel: '1',
  artifact: {
    ref: { kind: 'remote', url: 'https://example.test/plugin.jar' },
    sha512: 'a'.repeat(128),
    sizeBytes: 1,
    fileName: 'plugin.jar',
  },
  environment: 'server',
  loaders: ['paper'],
  gameVersions: ['1.21.11'],
  origin: 'user',
  requiredBy: [],
})

test('moderation needs both exact projects and a matching identifier in another catalog is insufficient', () => {
  expect(runsModeration([])).toBe(false)
  expect(runsModeration([pin(LIBERTYBANS)])).toBe(false)
  expect(runsModeration([pin(LUCKPERMS)])).toBe(false)
  expect(runsModeration([pin(LUCKPERMS), pin(LIBERTYBANS)])).toBe(true)
  expect(filtersChat([pin(LUCKPERMS), pin(LIBERTYBANS)])).toBe(false)
  expect(filtersChat([pin(CHATSENTINEL)])).toBe(true)
  expect(pinsProject([pin('different-project')], LIBERTYBANS)).toBe(false)
  expect(
    pinsProject(
      [{ ...pin(LIBERTYBANS), source: { catalog: 'another', projectId: LIBERTYBANS, versionId: 'version' } }],
      LIBERTYBANS,
    ),
  ).toBe(false)
  expect(
    pinsProject([{ ...pin(LIBERTYBANS), source: { catalog: 'upload', uploadId: LIBERTYBANS } }], LIBERTYBANS),
  ).toBe(false)
  const malformed: PinnedMod = JSON.parse(
    JSON.stringify({ ...pin(LIBERTYBANS), source: { catalog: 'modrinth' } }),
  )
  expect(pinsProject([malformed], LIBERTYBANS)).toBe(false)
})

test('only moderation-owned folders are replaced, and enabling the chat filter preserves its exact supplied file', () => {
  const base = moderationFiles(null)
  for (const file of base) expect(isModerationFile(file)).toBe(true)
  for (const path of [
    'plugins/LibertyBansExtra/config.yml',
    'plugins/LuckPermsOther/config.yml',
    'plugins/ChatSentinelBackup/config.yml',
    'plugins/Other/config.yml',
    'plugins/LuckPerms',
  ])
    expect(isModerationFile({ path, content: 'owner configuration' })).toBe(false)
  const content = 'filter settings supplied by the application\n'
  const enabled = moderationFiles(content)
  expect(enabled).toEqual([...base, { path: 'plugins/ChatSentinel/config.yml', content }])
  expect(moderationFiles(null)).toEqual(base)
})

test('helper membership comes from the helper parent, with canonical identities and optional names', () => {
  const second = '01234567-89ab-cdef-0123-456789abcdef'
  const payload = [
    '==user==',
    `uuid: '${uuid.toUpperCase()}'`,
    "name: 'Steve'",
    'parents:',
    "  - 'helper'",
    '==user==',
    `uuid: ${second}`,
    'name: null',
    'parents:',
    '  - helper',
    '==user==',
    'uuid: invalid',
    'name: Nobody',
    'parents:',
    '  - helper',
    '==user==',
    `uuid: ${uuid}`,
    'name: Unrelated',
    'parents:',
    '  - player',
    '==user==',
    `uuid: ${uuid}`,
    'name: NoParents',
  ].join('\n')
  expect(parseHelpers(payload)).toEqual([
    { uuid, name: 'Steve' },
    { uuid: second, name: '' },
  ])
  expect(parseHelpers('')).toEqual([])
  expect(helperCommand(uuid, false)).toBe(`lp user ${uuid} parent remove helper`)
})

test('timed punishments round up and never create a zero-minute punishment', () => {
  for (const kind of ['ban', 'mute'] as const) {
    const durations: [number, number][] = [
      [-1, 1],
      [0, 1],
      [0.1, 1],
      [1, 1],
      [1.1, 2],
      [59.2, 60],
    ]
    for (const [minutes, expected] of durations)
      expect(punishCommand({ kind, playerUuid: uuid, minutes, reason: 'reason' })).toBe(
        `libertybans ${kind} ${uuid} ${expected}m reason`,
      )
    expect(punishCommand({ kind, playerUuid: uuid, minutes: null, reason: ' \t\r\n ' })).toBe(
      `libertybans ${kind} ${uuid} perm`,
    )
  }
  for (const minutes of [null, 1])
    expect(punishCommand({ kind: 'warn', playerUuid: uuid, minutes, reason: 'Be\nkind' })).toBe(
      `libertybans warn ${uuid} Be kind`,
    )
  expect(punishCommand({ kind: 'warn', playerUuid: uuid, minutes: null, reason: 'x'.repeat(121) })).toBe(
    `libertybans warn ${uuid} ${'x'.repeat(120)}`,
  )
})

test('warnings stand alone while a replacement mute is lifted before its new duration is given', () => {
  expect(giveCommands({ kind: 'warn', playerUuid: uuid, minutes: null, reason: 'Be kind' })).toEqual([
    `libertybans warn ${uuid} Be kind`,
  ])
  expect(giveCommands({ kind: 'mute', playerUuid: uuid, minutes: 2, reason: 'Be kind' })).toEqual([
    `libertybans unmute ${uuid}`,
    `libertybans mute ${uuid} 2m Be kind`,
  ])
})

test('generated YAML denies every shared-address punishment and gives helpers only player-scoped actions', () => {
  const files = moderationFiles(null)
  const parse = (path: string) => {
    const file = files.find((entry) => entry.path === path)
    expect(file).toBeDefined()
    return Bun.YAML.parse(file?.content ?? '')
  }
  expect(parse('plugins/LuckPerms/config.yml')).toEqual({ 'storage-method': 'yaml' })
  const denied = []
  for (const action of ['ban', 'mute', 'warn', 'kick'])
    for (const operation of ['do', 'undo'])
      for (const target of ['ip', 'both'])
        denied.push({ [`libertybans.${action}.${operation}.target.${target}`]: { value: false } })
  expect(parse('plugins/LuckPerms/yaml-storage/groups/default.yml')).toEqual({
    name: 'default',
    permissions: denied,
  })
  expect(parse(HELPER_GROUP_FILE)).toEqual({
    name: 'helper',
    permissions: [
      'libertybans.commands',
      'libertybans.ban.do.target.uuid',
      'libertybans.ban.do.notify',
      'libertybans.mute.do.target.uuid',
      'libertybans.mute.do.notify',
      'libertybans.warn.do.target.uuid',
      'libertybans.warn.do.notify',
      'libertybans.kick.do.target.uuid',
      'libertybans.kick.do.notify',
      'libertybans.ban.undo.target.uuid',
      'libertybans.ban.undo.notify',
      'libertybans.mute.undo.target.uuid',
      'libertybans.mute.undo.notify',
      'libertybans.warn.undo.target.uuid',
      'libertybans.warn.undo.notify',
      'libertybans.list.history',
      'libertybans.list.warns',
      'libertybans.list.banlist',
      'libertybans.list.mutelist',
      'chatsentinel.notify',
      'grim.alerts',
      'grim.alerts.enable-on-join',
    ],
    parents: ['default'],
  })
  expect(parse('plugins/LibertyBans/config.yml')).toEqual({
    enforcement: {
      'address-strictness': 'LENIENT',
      'alts-registry': { 'should-register-on-connection': false },
    },
    commands: {
      aliases: [
        'ban',
        'mute',
        'warn',
        'kick',
        'unban',
        'unmute',
        'unwarn',
        'banlist',
        'mutelist',
        'history',
        'warns',
      ],
    },
  })
  expect(parse('plugins/LibertyBans/lang/messages_en.yml')).toMatchObject({
    additions: {
      bans: {
        layout: expect.arrayContaining([
          expect.stringContaining('%TIME_REMAINING%'),
          expect.stringContaining('%REASON%'),
        ]),
      },
    },
    formatting: { silence: { 'not-silent': '' } },
  })
})
