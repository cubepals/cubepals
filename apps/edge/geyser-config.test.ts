// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { type GeyserSettings, geyserConfig } from './geyser-config.ts'

const settings: GeyserSettings = {
  bedrock: { address: '127.0.0.1', port: 19131 },
  publicPort: 19132,
  java: { address: '127.0.0.1', port: 25565 },
  keyFile: 'key.pem',
  validateLogin: true,
  mtu: 1300,
}

test('Geyser routes by the name the player typed, signs players in, and reads who each is from the relay', () => {
  const config = geyserConfig(settings)
  expect(config).toContain('  forward-hostname: true')
  expect(config).toContain('  auth-type: floodgate')
  expect(config).toContain('    validate-bedrock-login: true')
  expect(config).toContain('    use-haproxy-protocol: true')
  expect(config.match(/use-haproxy-protocol: true/g)).toHaveLength(2)
  expect(config).toContain('    mtu: 1300')
  expect(config).toContain('    broadcast-port: 19132')
})

test('Xbox sign-in is off only when asked, and what players see says Cubepals', () => {
  expect(geyserConfig({ ...settings, validateLogin: false })).toContain('validate-bedrock-login: false')
  expect(geyserConfig(settings)).toContain('  primary-motd: Cubepals')
  expect(geyserConfig(settings)).not.toMatch(/blockly/i)
})
