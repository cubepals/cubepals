// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { LockBusy, type Locks } from '../ports/locks.ts'
import { singleKey } from '../secrets.ts'
import { ArtifactService } from './service.ts'

/** Every jar is being copied by somebody else: a holder waits as long as it says, then is refused. */
class CopyUnderWay implements Locks {
  readonly waits: number[] = []

  async hold<T>(key: string, waitMs: number): Promise<T> {
    this.waits.push(waitMs)
    await Bun.sleep(waitMs)
    throw new LockBusy(key)
  }
}

describe.skipIf(!hasDatabase)('a boot’s preflight', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(() => h.close())

  test('never waits for another boot’s copy of a jar: its server fetches the published file', async () => {
    const locks = new CopyUnderWay()
    const artifacts = new ArtifactService({
      db: h.db,
      archive: new MemoryStore(),
      secrets: singleKey('test-runtime-secrets-key-0123456789'),
      mirror: true,
      jobs: h.jobs,
      locks,
    })
    const cdn = new Cdn()
    const asked = Date.now()
    await artifacts.preflight({ mods: [cdn.publish('a'), cdn.publish('b')], acknowledgedRevoked: [] })
    expect(Date.now() - asked).toBeLessThan(1000)
    expect(locks.waits).toEqual([0, 0])
  })
})
