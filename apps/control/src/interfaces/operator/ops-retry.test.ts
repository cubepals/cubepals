// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server that didn't start last time, brought back from the command line over the real control
 * plane: a start is refused and says to retry, and a retry does what its owner's Try again does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { welcome } from '../../domain/revision/revision.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { OPS_BASE } from './gate.ts'
import { createOpsApi, type OpsApiOptions } from './ops.ts'

const TOKEN = 'operator-token'

describe.skipIf(!hasDatabase)('the operators’ API on a server that failed', () => {
  let h: Harness
  let api: ReturnType<typeof createOpsApi>

  beforeAll(async () => {
    h = await startHarness()
    api = createOpsApi({ ...h.app, upkeep: h.app.servers.upkeep, token: TOKEN } as unknown as OpsApiOptions)
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const post = (path: string) =>
    api.fetch(
      new Request(`http://internal${OPS_BASE}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-operator': 'ada',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

  test('refuses a start, saying to retry, and a retry brings it up as Try again does', async () => {
    const owner = await h.user()
    h.runtime.failBootWhen((spec) => (spec.env.MOTD === welcome('Stuck') ? 'bad world' : null))
    try {
      const { id } = await h.create(owner, { name: 'Stuck' })
      await h.until(id, 'failed', 30_000)
      h.runtime.failBootWhen(() => null)

      const started = await post(`/servers/${id}/start`)
      expect(started.ok).toBe(false)
      expect(await started.json()).toMatchObject({
        error: { code: 'invalid_transition', message: expect.stringContaining('ops.ts retry') },
      })
      expect((await h.server(id)).lifecycle.status).toBe('failed')

      const retried = await post(`/servers/${id}/retry`)
      expect(retried.status).toBe(200)
      await h.until(id, 'running')
    } finally {
      h.runtime.failBootWhen(() => null)
    }
  }, 60_000)
})
