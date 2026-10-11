// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Cloudflare Worker's entry (wrangler.jsonc's `main`): src/lib/before-next.ts, then /api to the
 * control plane, and everything else to OpenNext's generated worker, which runs Next.
 */
// @ts-expect-error: written by `opennextjs-cloudflare build`, so missing until a build has run.
import openNext from './.open-next/worker.js'
import { beforeNext, toControlPlane } from './src/lib/before-next'

export default {
  async fetch(request: Request, env: unknown, context: unknown): Promise<Response> {
    const next = beforeNext(request)
    if (next instanceof Response) return next
    const api = toControlPlane(next)
    return api ? fetch(api) : openNext.fetch(next, env, context)
  },
}
