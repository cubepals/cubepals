// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What people type, as the API's inputs take it: the names, seeds and file names on one line, a
 * description in lines, and nothing that shows nothing (`@blockly/contracts/plain-text`).
 */
import { describe, expect, test } from 'bun:test'
import {
  BeginModUploadInput,
  BeginPackUploadInput,
  BeginWorldUploadInput,
  CreateServerInput,
  CreateWorldInput,
  FinishWorldUploadInput,
  SaveIdentityInput,
  SuggestAddressInput,
} from '@blockly/contracts'
import { oneLine, plainLines } from '@blockly/contracts/plain-text'

const serverId = '00000000-0000-4000-8000-000000000001'
const change = { serverId, requestId: '00000000-0000-4000-8000-000000000002', version: 1 }
const sha512 = 'a'.repeat(128)

/** What people type that has no business being more than one line. */
const TYPED = 'Fun;(whoami; id) `id` $(id)\nmotd=hi\r\n\u0000 end'
const ONE_LINE = 'Fun;(whoami; id) `id` $(id) motd=hi end'

describe('one line', () => {
  test('control characters and line breaks become one space, and nothing else changes', () => {
    expect(oneLine(TYPED)).toBe(ONE_LINE)
    expect(oneLine('a \t b')).toBe('a b')
    for (const name of [
      'Steve’s World',
      'Ünïcödé 🌍 ✨',
      'a  b',
      '$HOME; rm -rf /',
      '../../etc',
      '日本のサーバー',
    ])
      expect(oneLine(name)).toBe(name)
  })

  test('a server’s name is one line wherever it is typed', () => {
    const create = CreateServerInput.parse({
      idempotencyKey: serverId,
      name: `\n${TYPED}\u0000`,
      partySize: '5',
      seed: '12\n34\u0000',
    })
    expect(create.name).toBe(ONE_LINE)
    expect(create.seed).toBe('12 34')
    expect(SaveIdentityInput.parse({ serverId, name: TYPED }).name).toBe(ONE_LINE)
    expect(SuggestAddressInput.parse({ name: TYPED }).name).toBe(ONE_LINE)
  })

  test('a name of nothing but control characters is no name', () => {
    expect(
      CreateServerInput.safeParse({ idempotencyKey: serverId, name: '\n\u0000\r', partySize: '5' }).success,
    ).toBe(false)
  })

  test('a world’s name and seed are one line', () => {
    const world = CreateWorldInput.parse({
      ...change,
      name: TYPED,
      seed: '-7\nlevel-type=flat',
      levelType: 'minecraft:normal',
      hardcore: false,
    })
    expect(world.name).toBe(ONE_LINE)
    expect(world.seed).toBe('-7 level-type=flat')
    expect(FinishWorldUploadInput.parse({ serverId, ticket: serverId, name: TYPED }).name).toBe(ONE_LINE)
  })

  test('an uploaded file’s name is one line', () => {
    const fileName = 'pack\n\u0000.zip'
    expect(BeginPackUploadInput.parse({ fileName, sizeBytes: 1 }).fileName).toBe('pack .zip')
    expect(BeginModUploadInput.parse({ serverId, fileName, sizeBytes: 1, sha512 }).fileName).toBe('pack .zip')
    expect(BeginWorldUploadInput.parse({ serverId, fileName, sizeBytes: 1 }).fileName).toBe('pack .zip')
  })
})

describe('lines of text', () => {
  test('a description keeps its lines and loses the rest', () => {
    expect(plainLines('one\r\ntwo\rthree four\tfive\u0000\u001b[31m')).toBe('one\ntwo\nthree\nfour five[31m')
    const description = 'Line one.\n\nLine two, with $(id) and `id`.'
    expect(SaveIdentityInput.parse({ serverId, description }).description).toBe(description)
    expect(SaveIdentityInput.parse({ serverId, description: '\u0000 Hi\r\nthere \u0007' }).description).toBe(
      'Hi\nthere',
    )
  })
})
