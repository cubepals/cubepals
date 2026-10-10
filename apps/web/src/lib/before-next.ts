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
 *   reads it, so nothing else pays for the copy.
 */
import { CLAIMED, clientAddressHeaders } from './client-address'
import { canonicalOrigin } from './site'

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
