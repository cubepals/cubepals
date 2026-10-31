// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Access files and console commands preserve identities and fail visibly on unreadable server state. */
import { expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccessCommand } from '../domain/access/access.ts'
import { accessCommand, accessFiles, NAME_CACHE, parseAccessFiles, writeAccessFiles } from './access.ts'

const player = { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Steve' }

test('a ban without a reason is the same player command on vanilla and plugin servers', () => {
  for (const reason of [null, '']) {
    expect(accessCommand({ type: 'ban', player, reason })).toBe('ban Steve')
    expect(accessCommand({ type: 'ban', player, reason }, true)).toBe('minecraft:ban Steve')
  }
  expect(accessCommand({ type: 'ban', player, reason: 'griefing' }, true)).toBe(
    'minecraft:ban Steve griefing',
  )
})

test('a reason stays on one console line and preserves the exact length boundary', () => {
  expect(accessCommand({ type: 'ban', player, reason: '\r griefing\nop Alex\t ' })).toBe(
    'ban Steve griefing op Alex',
  )
  for (const length of [119, 120, 121]) {
    const reason = 'x'.repeat(length)
    expect(accessCommand({ type: 'ban', player, reason })).toBe(
      `ban Steve ${'x'.repeat(Math.min(length, 120))}`,
    )
  }
})

test('plugin bans still reach Minecraft while whitelist commands keep their own namespace', () => {
  expect(accessCommand({ type: 'pardon', player }, true)).toBe('minecraft:pardon Steve')
  expect(accessCommand({ type: 'kick', player, reason: 'griefing' }, true)).toBe(
    'minecraft:kick Steve You are banned from this server. Reason: griefing',
  )
  expect(accessCommand({ type: 'whitelist_mode', enabled: true }, true)).toBe('whitelist on')
  expect(accessCommand({ type: 'whitelist_mode', enabled: false }, true)).toBe('whitelist off')
})

test('list changes address the intended player and use each plugin’s actual command protocol', () => {
  const commands: [AccessCommand, string][] = [
    [{ type: 'whitelist_add', player }, 'whitelist add Steve'],
    [{ type: 'whitelist_remove', player }, 'whitelist remove Steve'],
    [{ type: 'whitelist_reload' }, 'whitelist reload'],
    [{ type: 'op', player }, 'op Steve'],
    [{ type: 'deop', player }, 'deop Steve'],
    [{ type: 'pardon', player }, 'pardon Steve'],
    [{ type: 'pardon_ip', ip: '203.0.113.7' }, 'pardon-ip 203.0.113.7'],
    [{ type: 'helper_add', player }, `lp user ${player.uuid} parent add helper`],
    [{ type: 'helper_remove', player }, `lp user ${player.uuid} parent remove helper`],
    [{ type: 'unchecked_add', player }, `lp user ${player.uuid} permission set grim.exempt true`],
    [{ type: 'unchecked_remove', player }, `lp user ${player.uuid} permission unset grim.exempt`],
  ]
  for (const [command, expected] of commands) expect(accessCommand(command)).toBe(expected)
})

test('an unreadable or malformed access list is a failure rather than an empty successful read', () => {
  expect(() => parseAccessFiles('permission denied')).toThrow('The access files could not be read')
  for (const name of ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json']) {
    expect(() => parseAccessFiles(`@@${name}@@\n{\n@@server.properties@@\n`)).toThrow(
      `${name} is not valid JSON`,
    )
    for (const invalid of ['null', '{}', 'true', '17'])
      expect(() => parseAccessFiles(`@@${name}@@\n${invalid}\n@@server.properties@@\n`)).toThrow(
        `${name} is not a list`,
      )
  }
})

test('missing lists retain Minecraft defaults without inventing optional plugin membership', () => {
  expect(parseAccessFiles('@@server.properties@@\n')).toEqual({
    onlineMode: true,
    whitelistEnabled: false,
    whitelist: [],
    operators: [],
    bans: [],
    ipBans: [],
    helpers: null,
    unchecked: null,
    stopCheaters: null,
    pluginBans: false,
  })
})

test('file entries without a player identity are ignored and optional fields are normalized', () => {
  const uuid = 'ABCDEF0123456789ABCDEF0123456789'
  const canonical = 'abcdef01-2345-6789-abcd-ef0123456789'
  const observed = parseAccessFiles(
    [
      '@@whitelist.json@@',
      JSON.stringify([null, 'bad', [], {}, { uuid: '' }, { uuid: 17 }, { uuid, name: 42 }]),
      '@@ops.json@@',
      JSON.stringify([
        { uuid, name: 'Steve', level: 0, bypassesPlayerLimit: true },
        { uuid: player.uuid, level: '4', bypassesPlayerLimit: 'true' },
      ]),
      '@@banned-players.json@@',
      JSON.stringify([
        { ...player, reason: '', source: '', expires: 'forever' },
        { uuid, name: 'Alex', reason: 'griefing', source: 'Console', expires: '2027-01-01 00:00:00 +0000' },
      ]),
      '@@banned-ips.json@@',
      JSON.stringify([null, {}, { ip: '' }, { ip: 17 }, { ip: '203.0.113.7' }]),
      '@@server.properties@@',
      'online-mode=false\nwhite-list=true',
    ].join('\n'),
  )
  expect(observed).toMatchObject({
    onlineMode: false,
    whitelistEnabled: true,
    whitelist: [{ uuid: canonical, name: '' }],
    operators: [
      { uuid: canonical, name: 'Steve', level: 0, bypassesPlayerLimit: true },
      { uuid: player.uuid, name: '', level: 4, bypassesPlayerLimit: false },
    ],
    bans: [
      { ...player, reason: null, source: null, expiresAt: null },
      {
        uuid: canonical,
        name: 'Alex',
        reason: 'griefing',
        source: 'Console',
        expiresAt: '2027-01-01 00:00:00 +0000',
      },
    ],
    ipBans: [{ ip: '203.0.113.7' }],
  })
})

test('empty list writes clear memberships while omitted lists are left alone', () => {
  const now = new Date('2026-10-31T01:02:03Z')
  expect(accessFiles({}, now)).toEqual({})
  expect(accessFiles({ whitelist: [], operators: [], bans: [] }, now)).toEqual({
    'whitelist.json': '[]',
    'ops.json': '[]',
    'banned-players.json': '[]',
  })
  const serialized = accessFiles({ bans: [{ ...player, reason: null, source: null, expiresAt: null }] }, now)
  expect(JSON.parse(serialized['banned-players.json'] ?? 'null')).toEqual([
    {
      ...player,
      created: '2026-10-31 01:02:03 +0000',
      source: 'Cubepals',
      expires: 'forever',
      reason: 'Banned by an operator.',
    },
  ])
})

test('written access lists round-trip identities and explicit moderation details through the file reader', () => {
  const lists = {
    whitelist: [player],
    operators: [{ ...player, level: 2, bypassesPlayerLimit: true }],
    bans: [{ ...player, reason: 'griefing', source: 'Console', expiresAt: '2027-01-01 00:00:00 +0000' }],
  }
  const rendered = accessFiles(lists, new Date('2026-10-31T01:02:03Z'))
  expect(Object.keys(rendered).sort()).toEqual(['banned-players.json', 'ops.json', 'whitelist.json'])
  const output = [
    ...Object.entries(rendered).flatMap(([name, contents]) => [`@@${name}@@`, contents]),
    '@@server.properties@@',
    'white-list=true',
  ].join('\n')
  expect(parseAccessFiles(output)).toMatchObject(lists)
})

test('installed plugin membership is distinguished from absent plugins and keeps real player identities', () => {
  const user = [
    '==user==',
    `uuid: '${player.uuid.toUpperCase()}'`,
    "name: 'Steve'",
    'parents:',
    "- 'helper'",
    'permissions:',
    "- 'grim.exempt'",
  ].join('\n')
  const output = [
    '@@helpers@@',
    user,
    '@@unchecked@@',
    user,
    '@@plugin-bans@@',
    '@@stop-cheaters@@',
    'ours',
    '@@server.properties@@',
  ].join('\n')
  expect(parseAccessFiles(output)).toMatchObject({
    helpers: [player],
    unchecked: [player],
    pluginBans: true,
    stopCheaters: 'ours',
  })
  expect(
    parseAccessFiles('@@helpers@@\n@@unchecked@@\n@@stop-cheaters@@\nown\n@@server.properties@@'),
  ).toMatchObject({
    helpers: [],
    unchecked: [],
    pluginBans: false,
    stopCheaters: 'own',
  })
  expect(parseAccessFiles('@@stop-cheaters@@\nunrecognized\n@@server.properties@@').stopCheaters).toBeNull()
})

test('the real shell writer treats JSON as data, replaces links, and forgets names only when requested', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-access-write-'))
  const data = join(root, 'data')
  mkdirSync(data)
  try {
    const outside = join(root, 'outside.json')
    writeFileSync(outside, 'outside stays unchanged')
    symlinkSync(outside, join(data, 'whitelist.json'))
    writeFileSync(join(data, 'ops.json'), 'existing operators')
    writeFileSync(join(data, NAME_CACHE), 'cached names')
    const content = JSON.stringify([{ ...player, note: "literal 'quotes' and $(touch escaped)" }])
    const write = (files: Parameters<typeof writeAccessFiles>[0], forgetNames: boolean) => {
      const [shell, flag, script, ...args] = writeAccessFiles(files, forgetNames)
      if (!shell || !flag || !script) throw new Error('Access-file writes require an executable command')
      const result = Bun.spawnSync([shell, flag, script.replaceAll('/data', data), ...args], {
        cwd: data,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      })
      expect(result.exitCode).toBe(0)
      return result.stderr.toString()
    }
    expect(write({ 'whitelist.json': content }, false)).toContain('replaced a link at whitelist.json')
    expect(readFileSync(outside, 'utf8')).toBe('outside stays unchanged')
    expect(lstatSync(join(data, 'whitelist.json')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(data, 'whitelist.json'), 'utf8')).toBe(content)
    expect(readFileSync(join(data, 'ops.json'), 'utf8')).toBe('existing operators')
    expect(readFileSync(join(data, NAME_CACHE), 'utf8')).toBe('cached names')
    expect(existsSync(join(data, 'escaped'))).toBe(false)
    write({ 'ops.json': '[]', 'banned-players.json': '[]' }, true)
    expect(readFileSync(join(data, 'ops.json'), 'utf8')).toBe('[]')
    expect(readFileSync(join(data, 'banned-players.json'), 'utf8')).toBe('[]')
    expect(readFileSync(join(data, 'whitelist.json'), 'utf8')).toBe(content)
    expect(existsSync(join(data, NAME_CACHE))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
