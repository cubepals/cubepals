// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Cloudflare Worker's entry (wrangler.jsonc's `main`): src/lib/before-next.ts, then /api to the
 * control plane, and everything else to OpenNext's generated worker, which runs Next, the pages
 * anyone can read through the edge's cache (src/lib/edge-cache.ts).
 */
// @ts-expect-error: written by `opennextjs-cloudflare build`, so missing until a build has run.
import openNext from './.open-next/worker.js'
import { beforeNext, toControlPlane } from './src/lib/before-next'
import { type EdgeCache, fromEdge } from './src/lib/edge-cache'

/** wrangler.jsonc's version_metadata binding: which deploy of the Worker this is. */
interface Env {
  CF_VERSION_METADATA?: { id: string }
}
interface Context {
  waitUntil(work: Promise<unknown>): void
}

export default {
  async fetch(request: Request, env: Env, context: Context): Promise<Response> {
    const next = beforeNext(request)
    if (next instanceof Response) return next
    const api = toControlPlane(next)
    if (api) return fetch(api)
    return fromEdge(next, {
      version: env.CF_VERSION_METADATA?.id,
      cache: (caches as unknown as { default: EdgeCache }).default,
      render: (page) => openNext.fetch(page, env, context),
      later: (work) => context.waitUntil(work),
    })
  },
}
