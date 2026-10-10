/**
 * The Cloudflare Worker's entry (wrangler.jsonc's `main`): src/lib/before-next.ts, then OpenNext's
 * generated worker, which runs Next.
 */
// @ts-expect-error: written by `opennextjs-cloudflare build`, so missing until a build has run.
import openNext from './.open-next/worker.js'
import { beforeNext } from './src/lib/before-next'

export default {
  async fetch(request: Request, env: unknown, context: unknown): Promise<Response> {
    const next = beforeNext(request)
    return next instanceof Response ? next : openNext.fetch(next, env, context)
  },
}
