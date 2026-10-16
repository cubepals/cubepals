// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uploaded jars' malware checks, as operators read them under `/ops/v1/jar-checks`: the jars
 * quarantined, flagged, or not yet read, each with what it matched or does and who uploaded it;
 * the lists fetched again now; and a quarantined jar an operator found isn't malware released.
 * The checks themselves are `app/mods/jar-checks.ts`'s.
 */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { JarChecks } from '../../app/mods/jar-checks.ts'
import { OPS_BASE, operatorOf } from './gate.ts'

export interface JarCheckOptions {
  jarChecks: Pick<JarChecks, 'list' | 'refresh' | 'release'>
}

const State = z.enum(['checking', 'clean', 'flagged', 'quarantined'])
const SHA512 = z.string().regex(/^[0-9a-f]{128}$/)

export function jarCheckRoutes(app: Hono, { jarChecks }: JarCheckOptions): void {
  app.get(`${OPS_BASE}/jar-checks`, async (c) => {
    const state = c.req.query('state')
    return c.json({ checks: await jarChecks.list(state === undefined ? undefined : [State.parse(state)]) })
  })
  app.post(`${OPS_BASE}/jar-checks/refresh`, async (c) => c.json({ quarantined: await jarChecks.refresh() }))
  app.post(`${OPS_BASE}/jar-checks/:sha512/release`, async (c) => {
    await jarChecks.release(operatorOf(c), SHA512.parse(c.req.param('sha512')))
    return c.json({ released: true })
  })
}
