// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test } from 'bun:test'
import { bedrockLive, heroSmallPrint } from './bedrock'

const was = process.env.WEB_BEDROCK
afterEach(() => {
  if (was === undefined) delete process.env.WEB_BEDROCK
  else process.env.WEB_BEDROCK = was
})

describe('whether the pages say Bedrock works', () => {
  test('is off when the deployment says nothing', () => {
    delete process.env.WEB_BEDROCK
    expect(bedrockLive()).toBe(false)
  })

  test('is on only for 1', () => {
    process.env.WEB_BEDROCK = '1'
    expect(bedrockLive()).toBe(true)
    for (const other of ['', '0', 'true', 'yes']) {
      process.env.WEB_BEDROCK = other
      expect(bedrockLive()).toBe(false)
    }
  })

  test('the hero says coming soon until it is on', () => {
    expect(heroSmallPrint(false)).toContain('Bedrock is coming soon')
    expect(heroSmallPrint(true)).not.toContain('coming soon')
    expect(heroSmallPrint(true)).toContain('Bedrock')
  })
})
