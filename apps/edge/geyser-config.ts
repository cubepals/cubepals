// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The config the edge writes for Geyser before it starts it: only the settings that differ from
 * Geyser's own defaults, which it fills in around them (and rewrites the file with) on its first
 * start. Pure text, so what Geyser is told is testable without starting a JVM. Not for running
 * Geyser (`geyser.ts`) or for deciding where it is reached (`bedrock.ts`).
 */

export interface GeyserSettings {
  /** Where Geyser listens for Bedrock datagrams: loopback, behind the relay (`bedrock-relay.ts`). */
  bedrock: { address: string; port: number }
  /** The port players reach the relay on, which a ping tells clients to join. */
  publicPort: number
  /** Where Geyser dials a Java player's connection: this edge's own front door. */
  java: { address: string; port: number }
  /** Where the Floodgate key is, relative to Geyser's folder. */
  keyFile: string
  /**
   * Whether Xbox sign-in is checked. Always on where players are real; off only for a test edge
   * that joins with headless clients, which have no Xbox account.
   */
  validateLogin: boolean
  /** The largest datagram Geyser sends: Fly's UDP path carries about 1300 bytes whole. */
  mtu: number
}

/** What a Bedrock player sees of the server in their list and pause menu. */
const NAME = 'Cubepals'

/** The settings as the YAML file Geyser reads. */
export function geyserConfig(s: GeyserSettings): string {
  return `${[
    'bedrock:',
    `  address: ${s.bedrock.address}`,
    `  port: ${s.bedrock.port}`,
    '  transport: raknet',
    'java:',
    `  address: ${s.java.address}`,
    `  port: ${s.java.port}`,
    // The player's Bedrock identity is carried to the server by Floodgate, so no Java account is needed.
    '  auth-type: floodgate',
    // The name the player typed goes in the Java handshake, which the edge routes by.
    '  forward-hostname: true',
    'motd:',
    `  primary-motd: ${NAME}`,
    `  secondary-motd: ${NAME}`,
    '  passthrough-motd: false',
    // Geyser pings the Java server for its own message; ours is fixed, so it isn't asked every few seconds.
    '  ping-passthrough-interval: 3600',
    'gameplay:',
    `  server-name: ${NAME}`,
    'advanced:',
    `  floodgate-key-file: ${s.keyFile}`,
    '  java:',
    // Tells the front door whose connection it is: the player's own address, not the edge's.
    '    use-haproxy-protocol: true',
    '  bedrock:',
    `    broadcast-port: ${s.publicPort}`,
    `    mtu: ${s.mtu}`,
    // The relay says whose each player is (`bedrock-relay.ts`); a datagram that doesn't is ignored.
    '    use-haproxy-protocol: true',
    `    validate-bedrock-login: ${s.validateLogin}`,
    'enable-metrics: false',
  ].join('\n')}\n`
}
