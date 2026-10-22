// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { bedrockFromEnv } from './bedrock.ts'

test('without a Floodgate key the edge takes Java players only', () => {
  expect(bedrockFromEnv({}, 25565)).toBeNull()
})

test('Xbox sign-in stays on unless a test edge turns it off', () => {
  const key = Buffer.alloc(16).toString('base64')
  expect(bedrockFromEnv({ FLOODGATE_KEY: key }, 25565)?.validateLogin).toBe(true)
  expect(bedrockFromEnv({ FLOODGATE_KEY: key, BEDROCK_VALIDATE_LOGIN: 'false' }, 25565)?.validateLogin).toBe(
    false,
  )
  expect(bedrockFromEnv({ FLOODGATE_KEY: key, BEDROCK_PORT: '19140' }, 25570)).toMatchObject({
    port: 19140,
    front: 25570,
  })
})
