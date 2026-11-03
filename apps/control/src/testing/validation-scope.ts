// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Pinned files and a live validation lease, beside an ordinary server, for scoped-download contracts. */
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { type ModValidationPlanJson, schema } from '@blockly/db'
import { validationKey } from '../app/mods/validation-plan.ts'
import { defaultSettings } from '../domain/revision/revision.ts'
import type { Cdn } from './cdn.ts'
import type { Harness } from './harness.ts'
import { utf8, zipBytes } from './uploads.ts'

export async function validationScope(h: Harness, cdn: Cdn) {
  const owner = await h.user('Normal downloads', 'plus')
  const server = await h.create(owner, { loader: 'vanilla' })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  const mod = cdn.publish('scope-main'),
    companion = cdn.publish('scope-companion')
  const base: ModValidationPlanJson = {
    gameVersion: '26.3',
    loader: 'fabric',
    loaderVersion: '0.19.5',
    settings: defaultSettings({ name: 'Scope', gameMode: 'survival', maxPlayers: 1 }),
    mods: [mod],
    compat: [],
    modpack: null,
    files: [],
    memoryTier: '3g',
    storageGb: 5,
    provider: 'fake',
    regionKey: 'local',
  }
  const pack = cdn.publish(
    'scope-pack',
    Buffer.from(
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1',
            name: 'Scope',
            files: [],
            dependencies: { minecraft: base.gameVersion, 'fabric-loader': base.loaderVersion },
          }),
        ),
      }),
    ),
  )
  const plan = {
    ...base,
    compat: [companion],
    modpack: {
      catalog: 'modrinth',
      projectId: 'scope-pack',
      versionId: '1',
      name: 'Scope',
      versionLabel: '1',
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
