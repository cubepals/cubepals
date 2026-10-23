// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test } from 'bun:test'
import { landingMetadata } from '../landing/metadata'
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

  test('the hero says coming soon until it is on, and then nothing under the button', () => {
    expect(heroSmallPrint(false)).toContain('Bedrock is coming soon')
    expect(heroSmallPrint(true)).toBeNull()
  })

  test('the landing’s title and description name Bedrock and phones only where it is on', () => {
    const on = landingMetadata(true)
    expect(on.title).toEqual({
      absolute: 'Cubepals · Minecraft server hosting for friends, Java and Bedrock',
    })
    expect(on.description).toContain('on PC, phones and tablets')
    expect(on.openGraph?.description).toBe(on.description as string)
    const off = landingMetadata(false)
    expect(JSON.stringify(off)).not.toContain('Bedrock')
    expect(off.description).toContain('For Minecraft: Java Edition.')
  })
})
