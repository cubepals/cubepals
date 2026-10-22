// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import {
  bedrockDisplayName,
  floodgateName,
  floodgateUuid,
  isBedrockUuid,
  shownName,
  typedAsBedrock,
} from '@blockly/contracts'

describe('a Bedrock player as Floodgate names them', () => {
  test('the UUID carries the XUID in its low bits', () => {
    // Measured: the XUID 2535400000000000 was logged in as this UUID.
    expect(floodgateUuid('2535400000000000')).toBe('00000000-0000-0000-0009-01eed05d1000')
    expect(floodgateUuid('1')).toBe('00000000-0000-0000-0000-000000000001')
  })

  test('the name is the gamertag with the dot, spaces as underscores, cut to sixteen', () => {
    expect(floodgateName('Pixel Pal')).toBe('.Pixel_Pal')
    expect(floodgateName('AVeryLongGamertag1')).toBe('.AVeryLongGamert')
  })

  test('a UUID says whether its player is on Bedrock', () => {
    expect(isBedrockUuid(floodgateUuid('2535400000000000'))).toBe(true)
    expect(isBedrockUuid('00000000000000000009-01eed05d1000'.replace('-', ''))).toBe(true)
    expect(isBedrockUuid('5c107a17-e1cc-4e2a-9d09-97217184d539')).toBe(false)
    expect(isBedrockUuid('2289dfb4-69e8-34dd-94a2-8862994e2feb')).toBe(false)
  })

  test('pages show the gamertag, never the dotted name', () => {
    expect(bedrockDisplayName('.Pixel_Pal')).toBe('Pixel_Pal')
    expect(shownName({ uuid: floodgateUuid('2535400000000000'), name: '.Pixel' })).toBe('Pixel')
    expect(shownName({ uuid: '5c107a17-e1cc-4e2a-9d09-97217184d539', name: 'Steve' })).toBe('Steve')
  })

  test('a typed name asks for Bedrock when it starts with the dot', () => {
    expect(typedAsBedrock(' .Pixel')).toBe(true)
    expect(typedAsBedrock('Steve')).toBe(false)
  })
})
