// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A broken handler composition must fail inside a test, before it can accept work. */
import { describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('loading operation handlers', () => {
  test(
    'the composed application provisions a usable server',
    async () => {
      const h = await startHarness()
      try {
        const owner = await h.user()
        const server = await h.create(owner)
        await h.until(server.id, 'running')
        const operations = await h.settled(server.id)
        expect(operations).toEqual([expect.objectContaining({ kind: 'provision', status: 'succeeded' })])
        expect(h.runtime.machine(server.id)?.state).toBe('running')
        expect((await h.app.queries.get(owner, server.id)).status).toBe('running')
      } finally {
        await h.close()
      }
    },
    30 * SECOND_MS,
  )
})
