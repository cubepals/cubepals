// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A client's `ip:port`, written one way whoever reports it: the edge reads it from a PROXY header,
 * a Paper server from its socket, and each spells an IPv6 address its own way. Two reports of the
 * same connection then name the same source.
 */

/** `ip:port` in one spelling: an IPv4 address bare, an IPv6 one compressed and in brackets; null if it isn't one. */
export function sourceOf(given: string | undefined): string | null {
  const text = (given ?? '').trim().replace(/^\//, '')
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(text)
  const plain = /^([^:]+):(\d{1,5})$/.exec(text)
  // Java writes an IPv6 socket address unbracketed, its port after the last colon.
  const loose = bracketed ?? plain ?? /^([0-9a-f:.]+):(\d{1,5})$/i.exec(text)
  if (loose === null) return null
  const [, host = '', port = ''] = loose
  const address = ipOf(host)
  return address === null ? null : address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
}

/** The address alone of a source in `sourceOf`'s spelling. */
export function addressOfSource(source: string): string {
  return source.startsWith('[')
    ? source.slice(1, source.indexOf(']'))
    : source.slice(0, source.lastIndexOf(':'))
}

/** An IP address in one spelling, an IPv4 one wrapped in IPv6 unwrapped; null if it isn't one. */
function ipOf(host: string): string | null {
  const text = host.toLowerCase().split('%')[0] ?? ''
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text))
    return text.split('.').every((p) => Number(p) <= 255) ? text : null
  if (!text.includes(':')) return null
  try {
    // The URL parser writes an IPv6 address compressed, as RFC 5952 has it.
    const compressed = new URL(`http://[${text}]/`).hostname.slice(1, -1)
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(compressed)
    if (mapped === null) return compressed
    const [high, low] = [Number.parseInt(mapped[1] ?? '0', 16), Number.parseInt(mapped[2] ?? '0', 16)]
    return [high >> 8, high & 255, low >> 8, low & 255].join('.')
  } catch {
    return null
  }
}
