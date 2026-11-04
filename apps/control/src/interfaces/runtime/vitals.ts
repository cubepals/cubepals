// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a Paper server's reporter plugin posts how it ticks, once a minute, with the same
 * per-server token its jar links carry (`app/vitals/`). A server may post only so often: what is
 * past that is refused, and its reporter drops it. Beside the joins it reports (`joins.ts`), on a
 * path of its own, so a control plane that doesn't take these never refuses a join for them.
 */
import { ServerVitalsBatch } from '@blockly/contracts/server-vitals'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { ArtifactForbidden, type ArtifactService } from '../../app/artifacts/service.ts'
import { tuning } from '../../app/tuning.ts'
import type { VitalsService } from '../../app/vitals/service.ts'

export function createVitalsApp(deps: {
  artifacts: ArtifactService
  vitals: Pick<VitalsService, 'mayReport' | 'record'>
}): Hono {
  const app = new Hono()
  app.post(
    '/runtime/v1/servers/:serverId/vitals',
    // As much as one request may carry: the deployment's own limit, read as each comes.
    (c, next) =>
      bodyLimit({ maxSize: tuning().abuse.vitalsReportBytes, onError: (d) => d.body(null, 413) })(c, next),
    async (c) => {
      const serverId = c.req.param('serverId') ?? ''
      if (!z.uuid().safeParse(serverId).success) return c.body(null, 404)
      try {
        deps.artifacts.authorize(serverId, c.req.query('t') ?? '')
      } catch (error) {
        if (error instanceof ArtifactForbidden) return c.body(null, 403)
        throw error
      }
      if (!(await deps.vitals.mayReport(serverId))) return c.body(null, 429)
      const batch = ServerVitalsBatch.safeParse(await c.req.json().catch(() => null))
      if (!batch.success) return c.body(null, 400)
      await deps.vitals.record(serverId, batch.data.events)
      return c.body(null, 204)
    },
  )
  return app
}
