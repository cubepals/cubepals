// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Worker preflight reports the shared check and preserves deterministic versus retryable failures. */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { Cdn } from '../../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../../testing/harness.ts'
import { ArtifactUnavailable } from '../../artifacts/service.ts'
import { PermanentFailure } from '../../errors.ts'
import { IncompatibleMods, ValidationUnavailable } from '../../mods/validation-runtime.ts'
import { type DesiredRuntime, RuntimeSpecs } from '../../servers/specs.ts'
import { rechecks } from './rechecks.ts'

let h: Harness
let desired: DesiredRuntime
const cdn = new Cdn()

describe.skipIf(!hasDatabase)('worker compatibility preflight', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    const captured = spyOn(RuntimeSpecs.prototype, 'desired')
    try {
      const owner = await h.user('Worker preflight', 'plus')
      const { id } = await h.create(owner)
      await h.until(id, 'running')
      await h.settled(id)
      const result = captured.mock.results.at(-1)
      if (result?.type !== 'return') throw new Error('The fixture did not compile its runtime')
      desired = await result.value
    } finally {
      captured.mockRestore()
    }
  }, 30_000)
  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('the shared check owns the checking step and also works without a progress subscriber', async () => {
    const check = mock<Parameters<typeof rechecks>[0]['configuration']['check']>(
      async (_revision, _prepared, checking) => {
        await checking?.()
      },
    )
    const worker = checks(check)
    const step = mock(async () => {})
    await worker.preflight(desired, null, { step })
    expect(check).toHaveBeenCalledWith(desired.revision, desired, expect.any(Function))
    expect(step).toHaveBeenCalledTimes(1)
    expect(step).toHaveBeenCalledWith('checking_mods')
    await expect(worker.preflight(desired, null)).resolves.toBeUndefined()
  })

  test('known artifact and loader failures preserve the message as a permanent operation failure', async () => {
    const missing = new ArtifactUnavailable(cdn.publish('required'), 'revoked')
    for (const failure of [
      missing,
      new IncompatibleMods('Native conflict'),
      new ValidationUnavailable('Check unavailable'),
    ]) {
      const worker = checks(async () => {
        throw failure
      })
      const refusal = await worker.preflight(desired, null).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(PermanentFailure)
      expect((refusal as Error).message).toBe(failure.message)
    }
  })

  test('unclassified infrastructure errors retain their identity for the queue retry policy', async () => {
    const failure = new Error('Database unavailable')
    await expect(
      checks(async () => {
        throw failure
      }).preflight(desired, null),
    ).rejects.toBe(failure)
  })
})

function checks(check: Parameters<typeof rechecks>[0]['configuration']['check']) {
  return rechecks({ db: h.db, policy: { check: async () => ({ ok: true }) }, configuration: { check } })
}
