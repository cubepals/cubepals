// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import { requestServed } from '../../app/platform/telemetry.ts'

/**
 * Counts and times each request `listener` answers, by the route template it matched, never the
 * path asked for (`docs/metrics.md`). Registered first, so it sees every answer, the ones other
 * middleware gave included; one that throws past every handler counts as a 500.
 */
export function measured(listener: string): MiddlewareHandler {
  return async (c, next) => {
    const began = performance.now()
    let status = 500
    try {
      await next()
      status = c.res.status
    } finally {
      requestServed(listener, routePath(c, -1), c.req.method, status, performance.now() - began)
    }
  }
}
