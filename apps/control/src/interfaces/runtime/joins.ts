// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The second inbound path from game runtimes (§15.2): a Paper server's reporter plugin posts its
 * players' joins and its own boot, with the same per-server token its jar links carry. A server
 * may post only so much, so often: what is past that is refused, and its reporter drops it.
 */
import { ServerJoinBatch } from '@blockly/contracts/join-records'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ArtifactForbidden, type ArtifactService } from '../../app/artifacts/service.ts'
import type { JoinService } from '../../app/joins/service.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The most one request may carry. */
const MOST_BYTES = 64 * 1024
/** Mounted by `createRuntimeApp`, beside the jar links, on the same public listener. */
export function createJoinsApp(deps: { artifacts: ArtifactService; joins: JoinService }): Hono {
  const app = new Hono()
  app.post(
    '/runtime/v1/servers/:serverId/joins',
    bodyLimit({ maxSize: MOST_BYTES, onError: (c) => c.body(null, 413) }),
    async (c) => {
      const serverId = c.req.param('serverId') ?? ''
      if (!UUID.test(serverId)) return c.body(null, 404)
      try {
        deps.artifacts.authorize(serverId, c.req.query('t') ?? '')
      } catch (error) {
        if (error instanceof ArtifactForbidden) return c.body(null, 403)
        throw error
      }
      if (!(await deps.joins.mayReport(serverId))) return c.body(null, 429)
      const batch = ServerJoinBatch.safeParse(await c.req.json().catch(() => null))
      if (!batch.success) return c.body(null, 400)
      await deps.joins.recordServerEvents(serverId, batch.data.events)
      return c.body(null, 204)
    },
  )
  return app
}
