/**
 * The Cloudflare Worker's entry: OpenNext's generated worker, with what src/proxy.ts did on
 * Vercel done here first. Next 16's proxy runs only on the Node.js runtime, which OpenNext's
 * Cloudflare adapter calls experimental and unmaintained, so on Workers the sign-in endpoints get
 * the browser's address (lib/client-address.ts) before Next sees the request, and nothing the
 * browser claimed about it goes with it.
 */
// @ts-expect-error: written by `opennextjs-cloudflare build`, so missing until a build has run.
import openNext from './.open-next/worker.js'
import { CLAIMED, clientAddressHeaders } from './src/lib/client-address'

/** The same paths as proxy.ts's matcher, case included (next.config.ts's caseSensitiveRoutes). */
const SIGN_IN = /^\/api\/auth(\/|$)/

export default {
  async fetch(request: Request, env: unknown, context: unknown): Promise<Response> {
    if (!SIGN_IN.test(new URL(request.url).pathname)) return openNext.fetch(request, env, context)
    const headers = new Headers(request.headers)
    for (const name of CLAIMED) headers.delete(name)
    for (const [name, value] of Object.entries(clientAddressHeaders(request.headers)))
      headers.set(name, value)
    return openNext.fetch(new Request(request, { headers }), env, context)
  },
}
