// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { closeServer } from './listener.ts'
import { measured } from './measured.ts'

/**
 * A worker's own health, for Fly's check on the worker group (infra/fly/control.toml): 200 while
 * its scheduled passes still get recorded, 503 once they stop. It is served only where a worker
 * runs without the api, on the address the api would have taken. Returns how to stop it.
 */
export function serveWorkerHealth(
  listen: { host: string; port: number },
  worker: { beating(): boolean },
): () => Promise<void> {
  const app = new Hono()
    .use('*', measured('worker'))
    .get('/health', (c) => (worker.beating() ? c.json({ ok: true }) : c.json({ ok: false }, 503)))
  const server = serve({ fetch: app.fetch, hostname: listen.host, port: listen.port })
  return () => closeServer(server)
}
