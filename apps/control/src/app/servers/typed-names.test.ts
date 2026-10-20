// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { CreateServerInput } from '@blockly/contracts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from './persistence.ts'

// A name as the API takes it: what the contract leaves of it is what the server is called, and
// the message the server list shows under it is made from that.
describe.skipIf(!hasDatabase)('a name typed with line breaks and control characters', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('makes a server named on one line, whose settings save', async () => {
    for (const typed of ['Our\nWorld', 'Our\u0000World', 'Steve’s World, v2!']) {
      const owner = await h.user()
      const { name } = CreateServerInput.parse({ idempotencyKey: randomUUID(), name: typed, partySize: '5' })
      const { id } = await h.create(owner, { name })
      await h.until(id, 'running')
      await h.settled(id)
      const server = await h.server(id)
      const { settings } = await loadRevision(h.db, server.desiredRevisionId)
      expect(server.name).not.toMatch(/\p{Cc}/u)
      expect(settings.motd).not.toMatch(/\p{Cc}/u)
      await h.app.revisions.changeSettings(owner, id, { ...settings, difficulty: 'hard' }, randomUUID())
    }
  }, 60_000)
})
