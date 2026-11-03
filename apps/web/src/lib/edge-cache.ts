// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pages anyone can read, kept at Cloudflare's edge so a visitor who isn't signed in gets them
 * from the data centre nearest them instead of waiting for Next (worker.ts). Next marks every page
 * here `private, no-store`, because the frame asks who is signed in; a request with no session
 * cookie is nobody, so its page is the same for everyone and is kept, in the Workers Cache API,
 * which costs nothing.
 *
 * - Only the landing page, pricing, the guides and the policies (`PUBLIC_PAGES`), and only a plain
 *   GET for the document. A request with a session cookie, any other page, and Next's own
 *   navigation requests (RSC) go to Next and keep its `private, no-store`.
 * - A kept page is fresh for `FRESH_S`, as long as the plans it shows are kept (lib/plans.ts);
 *   after that it is still answered with, for up to `STALE_S`, while a new one is made behind it.
 * - Each deploy of the Worker is a version with its own keys, so a deploy never serves a page
 *   naming the last build's scripts: nothing has to be purged.
 * - A page the render marked partial (lib/partial-render.ts: its plans couldn't be read) is
 *   answered as Next made it and never kept, and a good copy already kept stays when a new render
 *   comes back partial.
 * - The landing page has two forms, the film and a phone's own (next.config.ts sends a phone the
 *   second at the same address), so it is kept once for each.
 *
 * Not what Next renders, nor the scripts and pictures, which `_next/static` already serves
 * immutable.
 */
import { DAY_S, MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { PHONE_AGENT, PHONE_HINT } from '../landing/phone/agent'
import { PARTIAL } from './partial-render'

/** The landing page, pricing, the guides and the policies: the same for everyone signed out. */
const PUBLIC_PAGES = /^\/(?:pricing|guides(?:\/[a-z0-9-]+)?|legal(?:\/[a-z0-9-]+)?)?$/

/** better-auth's session cookies, under whatever prefix the deployment gives them. */
const SESSION_COOKIE = /(?:^|;\s*)[^=;]*\.session_(?:token|data)=/

/** How long a kept page is answered with as it is, and then while a new one is made. */
export const FRESH_S = 5 * MINUTE_S
const STALE_S = DAY_S

/** When the page was kept, on the copy in the cache only. */
const KEPT_AT = 'x-blockly-kept-at'
/** Whether a page came from the edge (`hit`), was answered stale while renewed, or was made. */
export const EDGE = 'x-blockly-edge'

/** What the Worker's cache is asked; `caches.default` in the Worker. */
export interface EdgeCache {
  match(key: Request): Promise<Response | undefined>
  put(key: Request, response: Response): Promise<void>
}

const PHONE = {
  agent: new RegExp(`^${PHONE_AGENT}$`),
  hint: new RegExp(`^${PHONE_HINT}$`),
}

/**
 * The key a request's page is kept under in this version of the Worker, or null when it is never
 * kept: not a public page, not a plain GET for the document, or from someone signed in.
 */
function edgeKey(request: Request, version: string | undefined): Request | null {
  if (!version || request.method !== 'GET') return null
  const url = new URL(request.url)
  if (!PUBLIC_PAGES.test(url.pathname)) return null
  const headers = request.headers
  if (SESSION_COOKIE.test(headers.get('cookie') ?? '')) return null
  if (headers.has('rsc') || headers.has('next-router-prefetch') || url.searchParams.has('_rsc')) return null
  const phone =
    PHONE.agent.test(headers.get('user-agent') ?? '') ||
    PHONE.hint.test(headers.get('sec-ch-ua-mobile') ?? '')
  const form = url.pathname === '/' && phone ? 'phone' : 'page'
  return new Request(
    `${url.origin}/__edge/${encodeURIComponent(version)}/${form}${url.pathname}${url.search}`,
  )
}

/**
 * Whether Next's answer may be kept for everyone: a whole page, not one marked partial, that sets
 * nothing in the browser.
 */
const keepable = (response: Response) =>
  response.status === 200 &&
  !response.headers.has(PARTIAL) &&
  !response.headers.has('set-cookie') &&
  (response.headers.get('content-type') ?? '').startsWith('text/html')

/** As the browser is sent a page that isn't kept: Next's own answer, less the Worker's mark. */
function unkept(response: Response): Response {
  if (!response.headers.has(PARTIAL)) return response
  const headers = new Headers(response.headers)
  headers.delete(PARTIAL)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** As the browser is sent a kept page: always asked for again, while the edge keeps it. */
function answered(response: Response, edge: 'hit' | 'stale' | 'miss'): Response {
  const headers = new Headers(response.headers)
  headers.delete(KEPT_AT)
  headers.set('cache-control', `public, max-age=0, s-maxage=${FRESH_S}, stale-while-revalidate=${STALE_S}`)
  headers.set(EDGE, edge)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** As the cache keeps a page: for the whole time it may be answered with, stamped with when. */
function kept(response: Response, now: number): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', `public, max-age=${FRESH_S + STALE_S}`)
  headers.set(KEPT_AT, String(now))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * The page for `request`: from the edge when it is kept there, else from Next (`render`), kept
 * for whoever asks next. `later` runs what may finish after the answer (the Worker's waitUntil).
 */
export async function fromEdge(
  request: Request,
  {
    version,
    cache,
    render,
    later,
    now = Date.now,
  }: {
    version: string | undefined
    cache: EdgeCache
    render: (request: Request) => Promise<Response>
    later: (work: Promise<unknown>) => void
    now?: () => number
  },
): Promise<Response> {
  const key = edgeKey(request, version)
  if (!key) return unkept(await render(request))
  const keep = async (made: Response) => {
    if (keepable(made)) await cache.put(key, kept(made, now()))
  }
  const found = await cache.match(key)
  if (found) {
    const fresh = now() - Number(found.headers.get(KEPT_AT)) < FRESH_S * SECOND_MS
    if (!fresh) later(render(request).then(keep))
    return answered(found, fresh ? 'hit' : 'stale')
  }
  const made = await render(request)
  if (!keepable(made)) return unkept(made)
  later(keep(made.clone()))
  return answered(made, 'miss')
}
