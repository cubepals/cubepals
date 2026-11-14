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
  /**
   * Where Geyser listens: the machine's UDP address (Fly's `fly-global-services`), which NetherNet
   * answers players from directly, and the TCP port its built-in signaling binds there. Fly's proxy
   * doesn't connect to that address, so signaling is reached only through the agent's door
   * (`signalingDoor` in `bedrock.ts`).
   */
  bedrock: { address: string; signalingPort: number }
  /**
   * NetherNet, the one way Bedrock players join: signaling over HTTPS on the public Bedrock port
   * over TCP (Fly ends TLS), then the game over WebRTC on UDP `webrtcPort`, which players reach at
   * `advertise` (the edge's public IPv4 and that port).
   */
  nethernet: { webrtcPort: number; advertise: string[]; trustedProxies: string[] }
  /** Where Geyser dials a Java player's connection: this edge's own front door. */
  java: { address: string; port: number }
  /** Where the Floodgate key is, relative to Geyser's folder. */
  keyFile: string
  /**
   * Whether Xbox sign-in is checked. Always on where players are real; off only for a test edge
   * that joins with headless clients, which have no Xbox account.
   */
  validateLogin: boolean
}

/** What a Bedrock player sees of the server in their list and pause menu. */
const NAME = 'Cubepals'

/** The settings as the YAML file Geyser reads. */
export function geyserConfig(s: GeyserSettings): string {
  return `${[
    'bedrock:',
    `  address: ${s.bedrock.address}`,
    // Built-in signaling binds this port over TCP; the game's WebRTC has its own UDP port.
    `  port: ${s.bedrock.signalingPort}`,
    `  webrtc-port: ${s.nethernet.webrtcPort}`,
    // NetherNet alone: Bedrock 26.60 and later join by nothing else, and RakNet binds no port.
    '  transport: nethernet',
    '  signaling:',
    '    mode: builtin',
    '    advertise-addresses:',
    ...s.nethernet.advertise.map((address) => `    - ${JSON.stringify(address)}`),
    // The edge says where it is reached: asking public STUN servers would find Fly's outbound address instead.
    '    stun-discovery: false',
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
    // With either passthrough on, Geyser pings its Java address (this edge's front door) on a timer,
    // naming no server, which the front door counts as a Bedrock connection that found none. The
    // counts it would read are the fallback it shows anyway: its own players and `max-players`.
    '  passthrough-player-counts: false',
    'gameplay:',
    `  server-name: ${NAME}`,
    'advanced:',
    `  floodgate-key-file: ${s.keyFile}`,
    '  java:',
    // Tells the front door whose connection it is: the player's own address, not the edge's.
    '    use-haproxy-protocol: true',
    '  bedrock:',
    // Fly's proxy ends TLS in front of signaling and names the player in X-Forwarded-For.
    '    signaling-trusted-proxies:',
    ...s.nethernet.trustedProxies.map((range) => `    - ${JSON.stringify(range)}`),
    // A NetherNet player is known by the address signaling's proxy named, as Geyser did before
    // config version 12 made it a choice.
    '    prefer-signaling-proxy-address: true',
    `    validate-bedrock-login: ${s.validateLogin}`,
    'enable-metrics: false',
    // The layout above is this version's, so Geyser runs no migration over it.
    'config-version: 12',
  ].join('\n')}\n`
}
