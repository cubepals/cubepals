// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiddlewareHandler } from 'hono'

/** Exact origins, or patterns with a single `*` label: `https://*.preview.example.com`. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false
  return allowed.some((pattern) => {
    if (!pattern.includes('*')) return pattern === origin
    const [before = '', after = ''] = pattern.split('*')
    const literal = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${literal(before)}[a-z0-9-]+${literal(after)}$`).test(origin)
  })
}

/**
 * A change sent from another site is refused, as Better Auth refuses one on /api/auth: a browser
 * always names the page a change came from, and only Blockly's own pages may make one. A request
 * that names no page (a script, the web tier's server-side reads) isn't a browser's, so it has
 * no other site's page to come from.
 *
 * A change is also sent as JSON, which a browser won't send to another origin without asking
 * first. A form can post to any address without asking, and tRPC would take its body too, so a
 * same-site page could otherwise run a change that takes no input.
 */
export function ownPagesOnly(allowed: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
    const origin = c.req.header('origin')
    if (
      c.req.header('sec-fetch-site') === 'cross-site' ||
      (origin !== undefined && !originAllowed(origin, allowed))
    )
      return c.json({ error: 'Changes can only be made from Cubepals’ own pages.' }, 403)
    // Matched as tRPC matches it.
    if (!c.req.header('content-type')?.startsWith('application/json'))
      return c.json({ error: 'Changes are sent as JSON.' }, 415)
    await next()
  }
}
