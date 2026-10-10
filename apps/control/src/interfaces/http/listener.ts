import type { Server } from 'node:http'
import type { ServerType } from '@hono/node-server'

/** How long requests in flight get to finish once a listener closes. */
const REQUEST_GRACE_MS = 5_000

/**
 * Stops taking connections and ends idle keep-alive ones at once, which `close` alone would wait
 * out (the edge's polls keep one open), then ends whatever is still open after a grace period.
 */
export function closeServer(server: ServerType): Promise<void> {
  const http = server as Server
  return new Promise<void>((resolve) => {
    http.close(() => resolve())
    http.closeIdleConnections()
    setTimeout(() => http.closeAllConnections(), REQUEST_GRACE_MS).unref()
  })
}
