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
   * answers players from directly. RakNet's `port` there is reached only through the relay
   * (`bedrock-relay.ts`), which Fly doesn't expose.
   */
  bedrock: { address: string; port: number }
  /**
   * NetherNet, the transport Bedrock 26.60 and later join by: signaling over HTTP on
   * `signalingPort` (behind Fly's TLS, on the public Bedrock port over TCP), then the game over WebRTC
   * on UDP `webrtcPort`, which players reach at `advertise` (the edge's public IPv4 and that port).
   */
  nethernet: { webrtcPort: number; advertise: string[]; trustedProxies: string[] }
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
    `  webrtc-port: ${s.nethernet.webrtcPort}`,
    // NetherNet for Bedrock 26.60 and later, which no longer join over RakNet; RakNet for older ones.
    '  transport: both',
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
    // Only the relay, on this machine, may say so.
    '    haproxy-protocol-whitelisted-ips:',
    '    - 127.0.0.1',
    // Fly's proxy ends TLS in front of signaling and names the player in X-Forwarded-For.
    '    signaling-trusted-proxies:',
    ...s.nethernet.trustedProxies.map((range) => `    - ${JSON.stringify(range)}`),
    `    validate-bedrock-login: ${s.validateLogin}`,
    'enable-metrics: false',
    // The layout above is this version's, so Geyser runs no migration over it.
    'config-version: 11',
  ].join('\n')}\n`
}
