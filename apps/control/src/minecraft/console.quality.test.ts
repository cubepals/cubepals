// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Console input and responses preserve player identities and reject command smuggling. */
import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { announce, isPlainCommand, normalizeUuid, parseOnlinePlayers, refusedCommand } from './console.ts'

test('only nonempty printable commands up to the exact limit reach the console', () => {
  expect(isPlainCommand('')).toBe(false)
  for (const length of [1, 255, 256]) expect(isPlainCommand('x'.repeat(length))).toBe(true)
  expect(isPlainCommand('x'.repeat(257))).toBe(false)
  for (const control of ['\n', '\r', '\t', '\0', '\x1b', '\x7f', '\u0085'])
    expect(isPlainCommand(`say before${control}after`)).toBe(false)
  expect(isPlainCommand('say 你好 🧱')).toBe(true)
})

test('announcements are one JSON console command with text kept as data', () => {
  const command = announce(' \tHello "player"\\path\nnext\r ')
  const prefix = 'tellraw @a '
  expect(command.startsWith(prefix)).toBe(true)
  expect(command).not.toMatch(/[\r\n]/)
  expect(JSON.parse(command.slice(prefix.length))).toEqual({
    text: '',
    extra: [
      { text: '[Cubepals] ', color: 'aqua' },
      { text: 'Hello "player"\\path next', color: 'yellow' },
    ],
  })
})

test('UUID normalization preserves every hex digit, is idempotent, and accepts either wire format', () => {
  const compact = fc.array(fc.constantFrom(...'0123456789abcdef'), { minLength: 32, maxLength: 32 })
  fc.assert(
    fc.property(compact, (digits) => {
      const raw = digits.join('')
      const normalized = normalizeUuid(raw.toUpperCase())
      expect(normalized).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(normalized.replaceAll('-', '')).toBe(raw)
      expect(normalizeUuid(normalized.toUpperCase())).toBe(normalized)
      expect(normalizeUuid(normalized)).toBe(normalized)
    }),
    { seed: 91423, numRuns: 64 },
  )
  for (const value of ['Not-A-UUID', 'A'.repeat(31), 'A'.repeat(33), 'G'.repeat(32)])
    expect(normalizeUuid(value)).toBe(value.toLowerCase())
})

test('player-list responses preserve counts and names at their supported boundaries', () => {
  const first = 'ABCDEF0123456789ABCDEF0123456789'
  const second = '01234567-89ab-cdef-0123-456789abcdef'
  expect(
    parseOnlinePlayers(
      ` There are 2 of a max of 15 players online: A (${first}),\n.Pixel_123456789 (${second}) `,
    ),
  ).toEqual({
    online: 2,
    max: 15,
    players: [
      { name: 'A', uuid: 'abcdef01-2345-6789-abcd-ef0123456789' },
      { name: '.Pixel_123456789', uuid: second },
    ],
  })
  expect(parseOnlinePlayers('There are 12 of a max of 100 players online:')).toEqual({
    online: 12,
    max: 100,
    players: [],
  })
  for (const ending of ['', ':'])
    expect(parseOnlinePlayers(`There are 0 of a max of 20 players online${ending}`)).toEqual({
      online: 0,
      max: 20,
      players: [],
    })
  for (const invalid of [
    '',
    'permission denied',
    'There are many of a max of 20 players online:',
    'There are -1 of a max of 20 players online:',
  ])
    expect(parseOnlinePlayers(invalid)).toBeNull()
})

test('restricted commands remain restricted through aliases and nested execution', () => {
  for (const name of ['ban-ip', 'pardon-ip', 'stop']) {
    const reason = refusedCommand(name)
    expect(reason).toMatch(/\S/)
    for (const command of [
      `/${name.toUpperCase()} argument`,
      `execute run   ${name}`,
      `execute run\t\t${name}`,
      `  /Minecraft:${name.toUpperCase()} argument  `,
      `execute as @a run minecraft:execute if entity @s RUN /Minecraft:${name.toUpperCase()} argument`,
    ])
      expect(refusedCommand(command)).toBe(reason)
  }
  expect(refusedCommand('stop')).toContain('Stop button')
  expect(refusedCommand('ban-ip')).toContain('Ban the player')
})

test('ordinary arguments and inherited object-property names are not interpreted as blocked commands', () => {
  for (const command of [
    '',
    'say stop',
    'say execute run ban-ip',
    'execute run say stop',
    'execute as @a run',
    'constructor',
    'toString',
    '__proto__',
    'whitelist add Steve',
  ])
    expect(refusedCommand(command)).toBeNull()
})
