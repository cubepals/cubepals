// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PROXY protocol version 2: the header a proxy sends ahead of a connection's own bytes to say
 * whose connection it is (https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt, § 2.2).
 * Every player reaches a server through the edge, so without it a server sees the edge's one
 * address for all of them. The edge sends one to a server that reads it (Paper, with
 * `proxies.proxy-protocol`), and the control plane's status ping a LOCAL one, which the server
 * takes as a connection of the sender's own.
 *
 * Only TCP over IPv4 and IPv6, the connections Minecraft makes. Not for deciding which servers
 * read one: that is the server's spec's (`usesProxyProtocol`), carried on the edge's routes.
 */

/** The twelve bytes every v2 header opens with (§ 2.2). */
const SIGNATURE = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]
/** Version 2 in the high nibble, and the command in the low: PROXY (1), or LOCAL (0). */
const VERSION_PROXY = 0x21
const VERSION_LOCAL = 0x20
/** The address family in the high nibble, and the transport in the low: TCP over IPv4, over IPv6. */
const TCP4 = 0x11
const TCP6 = 0x21
/** The same families over UDP (the edge's Bedrock relay puts one ahead of each datagram). */
const UDP4 = 0x12
const UDP6 = 0x22
/** The signature, the version and command, the family, and the length of the addresses after them. */
const FIXED = 16

/** One end of a connection. */
export interface Peer {
  address: string
  port: number
}

/** A header with no addresses: a connection the sender makes on its own behalf, such as a health check. */
export const LOCAL_HEADER: Uint8Array = Uint8Array.from([...SIGNATURE, VERSION_LOCAL, 0x00, 0x00, 0x00])

/**
 * The header for a connection from `source` that arrived at `destination`. Both must be the same
 * family; an IPv4 address written as IPv6 (`::ffff:203.0.113.7`) counts as IPv4. `datagram` makes
 * it the header of a UDP datagram, not of a TCP connection.
 */
export function proxyHeader(source: Peer, destination: Peer, datagram = false): Uint8Array {
  const from = unmapped(source.address)
  const to = unmapped(destination.address)
  const six = from.includes(':')
  const addresses = six ? [...ipv6Bytes(from), ...ipv6Bytes(to)] : [...ipv4Bytes(from), ...ipv4Bytes(to)]
  const rest = [...addresses, ...twoBytes(source.port), ...twoBytes(destination.port)]
  const family = datagram ? (six ? UDP6 : UDP4) : six ? TCP6 : TCP4
  return Uint8Array.from([...SIGNATURE, VERSION_PROXY, family, ...twoBytes(rest.length), ...rest])
}

/**
 * A v2 header at the front of `bytes`: whose connection it is (null for LOCAL, or a family other
 * than TCP), and where the connection's own bytes begin. `none` when the bytes open with anything
 * else, as a Minecraft client's do; `more` while they may still be a header cut short.
 */
export function readProxyHeader(
  bytes: Uint8Array,
): { source: Peer | null; next: number } | 'more' | 'none' | 'bad' {
  for (let i = 0; i < Math.min(bytes.length, SIGNATURE.length); i++)
    if (bytes[i] !== SIGNATURE[i]) return 'none'
  if (bytes.length < FIXED) return 'more'
  const command = bytes[12]
  if (command !== VERSION_PROXY && command !== VERSION_LOCAL) return 'bad'
  const next = FIXED + ((bytes[14] ?? 0) << 8) + (bytes[15] ?? 0)
  if (bytes.length < next) return 'more'
  if (command === VERSION_LOCAL) return { source: null, next }
  const at = (offset: number) => ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0)
  if (bytes[13] === TCP4 && next - FIXED >= 12)
    return { source: { address: bytes.subarray(FIXED, FIXED + 4).join('.'), port: at(FIXED + 8) }, next }
  if (bytes[13] === TCP6 && next - FIXED >= 36) {
    const groups = Array.from({ length: 8 }, (_, i) => at(FIXED + i * 2).toString(16))
    return { source: { address: groups.join(':'), port: at(FIXED + 32) }, next }
  }
  return { source: null, next }
}

const twoBytes = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff]

/**
 * The longest an address is written, an IPv6 one with an IPv4 tail (45 characters), with room for
 * a zone. Anything longer is no address, and is refused before it is read.
 */
const LONGEST_ADDRESS = 64

/** An IPv4 address an IPv6 socket reports in IPv6's form (`::ffff:203.0.113.7`), written as IPv4 again. */
export function unmapped(address: string): string {
  const tail = address.slice('::ffff:'.length)
  return address.slice(0, '::ffff:'.length).toLowerCase() === '::ffff:' && tail.includes('.') ? tail : address
}

function ipv4Bytes(address: string): number[] {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    throw new Error(`not an IPv4 address: ${address.slice(0, LONGEST_ADDRESS)}`)
  return parts.map(Number)
}

function ipv6Bytes(address: string): number[] {
  if (address.length > LONGEST_ADDRESS) throw new Error('not an IPv6 address: too long')
  // A zone (`%eth0`) names the interface, not the address; an IPv4 tail is two groups.
  const zone = address.indexOf('%')
  let text = zone === -1 ? address : address.slice(0, zone)
  const tail = text.slice(text.lastIndexOf(':') + 1)
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = ipv4Bytes(tail)
    text = `${text.slice(0, -tail.length)}${((a << 8) + b).toString(16)}:${((c << 8) + d).toString(16)}`
  }
  const [head = '', rest, extra] = text.split('::')
  const before = head === '' ? [] : head.split(':')
  const after = rest === undefined || rest === '' ? [] : rest.split(':')
  const missing = 8 - before.length - after.length
  const groups = rest === undefined ? before : [...before, ...Array(Math.max(missing, 0)).fill('0'), ...after]
  if (extra !== undefined || groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group)))
    throw new Error(`not an IPv6 address: ${address}`)
  return groups.flatMap((group) => twoBytes(Number.parseInt(group, 16)))
}
