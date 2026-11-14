// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** However many ask about one revision's updates at once, one discovery runs for it. */

import { expect, test } from 'bun:test'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { ModChange, ModPlan } from './service.ts'
import { ModUpdates } from './updates.ts'

const revision = (id: string) =>
  ({
    id,
    modpack: null,
    mods: [{ source: { catalog: 'modrinth', projectId: 'p', versionId: 'v1' } } as PinnedMod],
  }) as unknown as ServerRevision

const upToDate: ModPlan = {
  kind: 'ok',
  basedOn: '',
  loader: 'fabric',
  mods: [],
  added: [],
  removed: [],
  updated: [],
  revoked: [],
}

test('a burst of asks for one revision runs one discovery, then answers from what it kept', async () => {
  let plans = 0
  const gate = Promise.withResolvers<void>()
  const updates = new ModUpdates({
    catalog: { versionsByIds: async () => new Map() },
    plan: async (_desired: ServerRevision, _change: ModChange) => {
      plans++
      await gate.promise
      return upToDate
    },
  })
  const asked = Array.from({ length: 20 }, () => updates.of(revision('r1')))
  gate.resolve()
  await Promise.all(asked)
  await updates.of(revision('r1'))
  expect(plans).toBe(1)
})

test('a discovery that fails isn’t kept: the next ask runs one again', async () => {
  let plans = 0
  const updates = new ModUpdates({
    catalog: { versionsByIds: async () => new Map() },
    plan: async () => {
      plans++
      if (plans === 1) throw new Error('the catalog is down')
      return upToDate
    },
  })
  await expect(updates.of(revision('r2'))).rejects.toThrow('the catalog is down')
  expect((await updates.of(revision('r2'))).upgrade).toEqual([])
  expect(plans).toBe(2)
})
