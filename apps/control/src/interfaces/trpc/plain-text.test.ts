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
  JoinThroughInviteInput,
  SaveIdentityInput,
  SuggestAddressInput,
} from '@blockly/contracts'
import { oneLine, plainLines } from '@blockly/contracts/plain-text'

const serverId = '00000000-0000-4000-8000-000000000001'
const change = { serverId, requestId: '00000000-0000-4000-8000-000000000002', version: 1 }
const sha512 = 'a'.repeat(128)

/** The line separator, which some keyboards and pastes put in text. */
const SEPARATOR = String.fromCodePoint(0x2028)

/** A name typed over more than one line, with a character that shows nothing in it. */
const TYPED = `Steve’s World, v2!\nOur\r\n\u0000${SEPARATOR} World`
const ONE_LINE = 'Steve’s World, v2! Our World'

describe('one line', () => {
  test('control characters and line breaks become one space, and nothing else changes', () => {
    expect(oneLine(TYPED)).toBe(ONE_LINE)
    expect(oneLine('a \t b')).toBe('a b')
    for (const name of [
      'Steve’s World',
      'Ünïcödé 🌍 ✨',
      'a  b',
      'Steve’s World, v2!',
      'Our (very) own: world #1 & co.',
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
      seed: '-7\n12',
      levelType: 'minecraft:normal',
      hardcore: false,
    })
    expect(world.name).toBe(ONE_LINE)
    expect(world.seed).toBe('-7 12')
    expect(FinishWorldUploadInput.parse({ serverId, ticket: serverId, name: TYPED }).name).toBe(ONE_LINE)
  })

  test('a name typed on an invitation is one line, and a Minecraft name stays as it is', () => {
    const code = 'abcdefghjkmn'
    expect(JoinThroughInviteInput.parse({ code, playerName: 'Steve\n\u0000' }).playerName).toBe('Steve')
    expect(JoinThroughInviteInput.parse({ code, playerName: 'Our\u0000World' }).playerName).toBe('Our World')
    expect(JoinThroughInviteInput.parse({ code, playerName: 'Steve_2' }).playerName).toBe('Steve_2')
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
    expect(plainLines(`one\r\ntwo\rthree${SEPARATOR}four\tfive\u0000\u0007!`)).toBe(
      'one\ntwo\nthree\nfour five!',
    )
    const description = 'Line one.\n\nLine two, with “quotes”, commas & (brackets).'
    expect(SaveIdentityInput.parse({ serverId, description }).description).toBe(description)
    expect(SaveIdentityInput.parse({ serverId, description: '\u0000 Hi\r\nthere \u0007' }).description).toBe(
      'Hi\nthere',
    )
  })
})
