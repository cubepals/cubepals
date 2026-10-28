// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { CLIENT_ADDRESS_HEADER } from '../../app/ports/auth.ts'

/** What the web tier says about a browser: its address, and the secret that makes it believed. */
export const FORWARDED_CLIENT = 'x-blockly-client'
export const FORWARDED_BY = 'x-blockly-proxy'

export interface AddressTrust {
  /** The secret the web tier sends with a browser's address (WEB_PROXY_SECRET); null, no one's. */
  proxySecret: string | null
  /** A header the host's own proxy sets and overwrites (Fly's `fly-client-ip`); null elsewhere. */
  hostHeader: string | null
}

/**
 * The address of the client behind a request: the web tier's word when it carries the secret,
 * since browsers only reach the API through it; otherwise the address the host's proxy saw, which
 * is the caller's own when it came straight here; otherwise null. A browser can name neither.
 */
export function clientAddressOf(headers: Headers, trust: AddressTrust): string | null {
  const vouched = trust.proxySecret !== null && sameSecret(headers.get(FORWARDED_BY), trust.proxySecret)
  const said = vouched ? headers.get(FORWARDED_CLIENT) : null
  const seen = trust.hostHeader === null ? null : headers.get(trust.hostHeader)
  return [said, seen].map((value) => value?.trim() ?? '').find((value) => isIP(value) !== 0) ?? null
}

/**
 * A request to the auth endpoints, its client's address (`clientAddressOf`) in
 * CLIENT_ADDRESS_HEADER; without one, Better Auth counts it as localhost in development. Whatever a
 * caller wrote in any of these headers is dropped first, so no one names their own address.
 */
export function withClientAddress(request: Request, trust: AddressTrust): Request {
  const headers = new Headers(request.headers)
  const address = clientAddressOf(headers, trust)
  headers.delete(CLIENT_ADDRESS_HEADER)
  headers.delete(FORWARDED_CLIENT)
  headers.delete(FORWARDED_BY)
  if (address !== null) headers.set(CLIENT_ADDRESS_HEADER, address)
  return new Request(request, { headers })
}

function sameSecret(given: string | null, secret: string): boolean {
  if (given === null) return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
