// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Cloudflare Worker's entry (wrangler.jsonc's `main`): src/lib/before-next.ts, then /api to the
 * control plane, and everything else to OpenNext's generated worker, which runs Next, the pages
 * anyone can read through the edge's cache (src/lib/edge-cache.ts). OpenNext's worker is loaded
 * inside fetch, so nothing of Next runs when the script starts, and whatever it throws, or answers
 * as a 5xx without a page, is answered with the static 503 page instead (src/lib/fallback.ts).
 * Every answer carries the site's own headers (src/lib/site-headers.ts).
 */
import { beforeNext, toControlPlane } from './src/lib/before-next'
import { type EdgeCache, fromEdge } from './src/lib/edge-cache'
import { withFallback } from './src/lib/fallback'
import { markingPartial } from './src/lib/partial-render'
import { withSiteHeaders } from './src/lib/site-headers'

/** wrangler.jsonc's version_metadata binding: which deploy of the Worker this is. */
interface Env {
  CF_VERSION_METADATA?: { id: string }
  ASSETS?: { fetch(request: Request): Promise<Response> }
}
interface Context {
  waitUntil(work: Promise<unknown>): void
}

/** The answer for `request`, before the site's own headers are added. */
async function answer(request: Request, env: Env, context: Context): Promise<Response> {
  const next = beforeNext(request)
  if (next instanceof Response) return next
  const api = toControlPlane(next)
  if (api) return withFallback(request, env.ASSETS, () => fetch(api), false)
  return fromEdge(next, {
    version: env.CF_VERSION_METADATA?.id,
    cache: (caches as unknown as { default: EdgeCache }).default,
    render: (page) =>
      withFallback(page, env.ASSETS, () =>
        markingPartial(async () => {
          // @ts-expect-error: written by `opennextjs-cloudflare build`, so missing until a build has run.
          const { default: openNext } = await import('./.open-next/worker.js')
          return openNext.fetch(page, env, context)
        }),
      ),
    later: (work) => context.waitUntil(work),
  })
}

export default {
  async fetch(request: Request, env: Env, context: Context): Promise<Response> {
    return withSiteHeaders(await answer(request, env, context))
  },
}
