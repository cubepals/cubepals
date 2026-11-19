// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { landingMetadata } from './metadata'

describe('the landing’s title and description', () => {
  test('name Java and Bedrock, and phones and tablets', () => {
    const metadata = landingMetadata()
    expect(metadata.title).toEqual({
      absolute: 'Cubepals · Minecraft server hosting for friends, Java and Bedrock',
    })
    expect(metadata.description).toContain('on PC, phones and tablets')
    expect(metadata.openGraph?.description).toBe(metadata.description as string)
  })
})
