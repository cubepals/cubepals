// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Cloudflare Worker (worker.ts) does with a request before Next sees it. Next 16 runs a
 * proxy only on the Node.js runtime, which OpenNext's Cloudflare adapter calls experimental and
 * unmaintained, so this is where it happens instead:
 *
 * - the `www.` name of the site's host is sent to the host itself for good, path and query kept;
 * - a call to the control plane's sign-in endpoints says whose browser it came from
 *   (client-address.ts), and nothing the browser claimed about that goes with it. Only /api/auth
 *   reads it, so nothing else pays for the copy;
 * - a call to /api goes to the control plane as it is, and its answer comes back as it is
 *   (toControlPlane). next.config.ts's rewrite does the same in development and the self-hosted
 *   image, but on the Worker it follows redirects itself, so sign-in's last redirect, the one that
 *   sets the session cookie, never reached the browser.
 */
import { CLAIMED, clientAddressHeaders } from './client-address'
import { canonicalOrigin } from './site'
import { apiUpstream } from './upstream'

/** The sign-in endpoints, case included: next.config.ts's caseSensitiveRoutes makes /API/auth a 404. */
const SIGN_IN = /^\/api\/auth(\/|$)/

/** The request Next should get, or the answer that stands in for it. */
export function beforeNext(request: Request): Request | Response {
  const url = new URL(request.url)
  const site = new URL(canonicalOrigin())
  if (url.hostname === `www.${site.hostname}`)
    return Response.redirect(`${site.origin}${url.pathname}${url.search}`, 308)
  if (!SIGN_IN.test(url.pathname)) return request
  const headers = new Headers(request.headers)
  for (const name of CLAIMED) headers.delete(name)
  for (const [name, value] of Object.entries(clientAddressHeaders(request.headers))) headers.set(name, value)
  return new Request(request, { headers })
}

/** The control plane's routes, case included, as next.config.ts's rewrite matches them. */
const API = /^\/api\//

/**
 * The request to send the control plane for a call to /api, or null for anything else. Its
 * redirects are the browser's to follow (`redirect: 'manual'`), and it is told the site's own host
 * and scheme, as the rewrite tells it.
 */
export function toControlPlane(request: Request): Request | null {
  const url = new URL(request.url)
  if (!API.test(url.pathname)) return null
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''))
  const bodyless = request.method === 'GET' || request.method === 'HEAD'
  return new Request(`${apiUpstream()}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: bodyless ? null : request.body,
    redirect: 'manual',
    // A streamed body, which Node and Bun ask to be said; the Worker's fetch ignores it.
    ...(bodyless ? {} : { duplex: 'half' }),
  } as RequestInit)
}
