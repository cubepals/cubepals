// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Pinned bytes and a live validation lease, using the application's actual configuration planner. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { validationKey } from '../app/mods/validation-plan.ts'
import { loadRevision } from '../app/servers/persistence.ts'
import type { Cdn } from './cdn.ts'
import type { Harness } from './harness.ts'

export async function validationScope(h: Harness, cdn: Cdn) {
  const owner = await h.user(randomUUID(), 'plus')
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  const mod = cdn.publish(randomUUID()),
    companion = cdn.publish(randomUUID()),
    pack = cdn.publish(randomUUID())
  const revision = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
  const base = await h.app.configuration.plan({ ...revision, mods: [mod] })
  assert(base)
  // Access checks concern exact artifact identities; this pack is never installed.
  const plan = {
    ...base,
    compat: [companion],
    modpack: {
      catalog: pack.source.catalog,
      projectId: pack.artifact.sha512,
      versionId: pack.artifact.sha512,
      name: pack.name,
      versionLabel: pack.versionLabel,
      artifact: pack.artifact,
      page: null,
    },
  }
  const key = validationKey(plan),
    runtimeId = randomUUID(),
    leaseUntil = new Date(Date.now() + MINUTE_MS)
  await h.db.insert(schema.modValidations).values({ key, plan, runtimeId, leaseUntil })
  await h.db.insert(schema.modValidationRuns).values({ id: runtimeId, key, leaseUntil })
  return { server, mod, companion, pack, base, key, runtimeId, leaseUntil }
}
