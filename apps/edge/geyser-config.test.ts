// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the edge tells Geyser, read as the text Geyser reads: how it routes and signs players in,
 * which transports it takes them on, and what it does on its own. Not Geyser running (`geyser.ts`).
 */
import { expect, test } from 'bun:test'
import { type GeyserSettings, geyserConfig } from './geyser-config.ts'

const settings: GeyserSettings = {
  bedrock: { address: '172.19.0.2', port: 19131 },
  nethernet: { webrtcPort: 19133, advertise: ['198.51.100.7:19133'], trustedProxies: ['172.16.0.0/12'] },
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
  // On the Java side the header is a switch; on the Bedrock side, listing the relay turns it on.
  expect(config).toContain('  java:\n    use-haproxy-protocol: true')
  expect(config.match(/use-haproxy-protocol/g)).toHaveLength(1)
  expect(config).toContain('    mtu: 1300')
  expect(config).toContain('    broadcast-port: 19132')
})

test('Xbox sign-in is off only when asked, and what players see says Cubepals', () => {
  expect(geyserConfig({ ...settings, validateLogin: false })).toContain('validate-bedrock-login: false')
  expect(geyserConfig(settings)).toContain('  primary-motd: Cubepals')
  expect(geyserConfig(settings)).not.toMatch(/blockly/i)
})

test('Geyser never pings the front door itself, so a Bedrock connection the edge counts is a player', () => {
  const config = geyserConfig(settings)
  // Geyser starts its ping timer when either passthrough is on; both default to on.
  expect(config).toContain('  passthrough-motd: false')
  expect(config).toContain('  passthrough-player-counts: false')
  expect(config).not.toContain('ping-passthrough-interval')
})

test('Bedrock 26.60 and later join over NetherNet, at the public address given, and older ones over RakNet', () => {
  const config = geyserConfig(settings)
  expect(config).toContain('  transport: both')
  expect(config).toContain('  webrtc-port: 19133')
  expect(config).toContain('    mode: builtin')
  expect(config).toContain('    - "198.51.100.7:19133"')
  expect(config).toContain('    stun-discovery: false')
  // Only the relay may say whose a RakNet datagram is; only Fly's proxy whose a signaling request is.
  expect(config).toContain('    haproxy-protocol-whitelisted-ips:\n    - 127.0.0.1')
  expect(config).toContain('    signaling-trusted-proxies:\n    - "172.16.0.0/12"')
  expect(config).toContain('    prefer-signaling-proxy-address: true')
  expect(config).toContain('config-version: 12')
})
