// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Runtime bindings preserve the booted configuration and clean up only failed compute. */
import { describe, expect, spyOn, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { hasDatabase, startHarness } from '../../../testing/harness.ts'
import { PermanentFailure } from '../../errors.ts'
import { RuntimeRouter } from '../../runtimes/router.ts'
import { loadRuntime, saveHandle, saveMemoryKept } from '../../servers/persistence.ts'
import type { OperationContext } from '../runner.ts'
import { appliedConfig, bootedBack, serverBinding } from './binding.ts'

const fixture = async () => {
  const h = await startHarness({ movingAddresses: true, otherRuntimes: [{ provider: 'elsewhere' }] })
  try {
    const owner = await h.user()
    const created = await h.create(owner)
    const server = await h.until(created.id, 'running')
    const [op] = await h.settled(server.id)
    if (!op) throw new Error('The provision operation must exist')
    const runtime = new RuntimeRouter([...h.runtimes.values()])
    const binding = serverBinding({ db: h.db, runtime, jobs: h.jobs })
    const bound = await binding.bindingOf(server.id)
    if (!bound.handle) throw new Error('A running server must have a handle')
    return { h, server, op, runtime, binding, handle: bound.handle }
  } catch (error) {
    await h.close()
    throw error
  }
}

const configurations = async () => {
  const { h, server } = await fixture()
  try {
    const desired = await h.app.specs.desired(h.db, server)
    const previous = appliedConfig(server, desired)
    expect(previous).toEqual({
      revisionId: server.desiredRevisionId,
      worldId: server.activeWorldId,
      memoryTier: server.memoryTier,
      regionKey: server.regionKey,
      specDigest: desired.digest,
      driftDigest: desired.driftDigest,
      secretsVersion: desired.secretsVersion,
      proxyProtocol: desired.proxyProtocol,
      compat: desired.compat,
      placedStopCheaters: desired.stopCheaters,
    })
    const back = await h.app.specs.forConfig(h.db, server, { ...previous, memoryTier: '4g' })
    expect(bootedBack(previous, back)).toEqual({
      ...previous,
      specDigest: back.digest,
      driftDigest: back.driftDigest,
      proxyProtocol: back.proxyProtocol,
      compat: back.compat,
      placedStopCheaters: back.stopCheaters,
    })
    expect(back.digest).not.toBe(previous.specDigest)
  } finally {
    await h.close()
  }
}

const recordsBoot = async () => {
  const { h, server, runtime, binding } = await fixture()
  const eligibility = spyOn(h.jobs, 'enqueueEligibility')
  try {
    const desired = await h.app.specs.forConfig(h.db, server, {
      revisionId: server.desiredRevisionId,
      worldId: server.activeWorldId,
      memoryTier: '4g',
    })
    const config = appliedConfig({ ...server, memoryTier: '4g' }, desired)
    await h.db.transaction((tx) => binding.booted(tx, server.id, config))
    expect((await loadRuntime(h.db, server.id, runtime.providers)).applied).toEqual(config)
    expect(eligibility).toHaveBeenCalledTimes(1)
    expect(eligibility.mock.calls[0]?.[0]).toEqual([server.id])
  } finally {
    eligibility.mockRestore()
    await h.close()
  }
}

const progress = async () => {
  const { h, server, op, binding, runtime, handle } = await fixture()
  try {
    const steps: Parameters<OperationContext['step']>[0][] = []
    const marks: Parameters<OperationContext['mark']>[0][] = []
    const ctx: OperationContext = {
      server,
      op,
      step: async (step) => {
        steps.push(step)
      },
      mark: async (mark) => {
        marks.push(mark)
      },
      reached: () => null,
      stillApplies: async () => true,
    }
    const sink = binding.progressSink(ctx, server)
    await sink.step('storage')
    await saveMemoryKept(h.db, server.id, false)
    await sink.mark?.('not_asleep')
    await saveMemoryKept(h.db, server.id, true)
    await sink.mark?.('not_asleep')
    await sink.mark?.('other_spec')
    expect(steps).toEqual(['storage'])
    expect(marks).toEqual(['not_asleep', 'memory_lost', 'other_spec'])
    await runtime.stop(handle)
    const next = await runtime.start(handle)
    await sink.handle(next)
    const saved = await loadRuntime(h.db, server.id, runtime.providers)
    expect(saved.handle).toEqual(next)
    expect(saved.placementRegionKey).toBe(server.regionKey)
  } finally {
    await h.close()
  }
}

const startsCompute = async () => {
  const { h, server, binding, runtime, handle } = await fixture()
  try {
    expect(await binding.startCompute(server.id, handle)).toBe(handle)
    await runtime.stop(handle)
    const next = await binding.startCompute(server.id, handle)
    expect(next).not.toEqual(handle)
    expect((await loadRuntime(h.db, server.id, runtime.providers)).handle).toEqual(next)
  } finally {
    await h.close()
  }
}

const foreignProvider = async () => {
  const { h, server } = await fixture()
  try {
    const other = h.runtimes.get('elsewhere')
    if (!other) throw new Error('The second runtime must exist')
    const binding = serverBinding({ db: h.db, runtime: new RuntimeRouter([other]), jobs: h.jobs })
    await expect(binding.bindingOf(server.id)).rejects.toBeInstanceOf(PermanentFailure)
    expect(h.runtime.machine(server.id)?.state).toBe('running')
  } finally {
    await h.close()
  }
}

const failedCompute = async () => {
  const { h, server, op, runtime, binding, handle } = await fixture()
  try {
    const abandon = binding.stopWhatFailed(['running'])
    await abandon(op, 'cancelled', 'cancelled')
    await binding.stopWhatFailed(['starting'])(op, 'failed', 'failed')
    await abandon({ ...op, serverId: crypto.randomUUID() }, 'failed', 'failed')
    await saveHandle(h.db, server.id, null)
    await abandon(op, 'failed', 'failed')
    expect(h.runtime.machine(server.id)?.state).toBe('running')
    await saveHandle(h.db, server.id, handle)
    await abandon(op, 'failed', 'failed')
    expect(h.runtime.machine(server.id)?.state).toBe('stopped')
    const next = await runtime.start(handle)
    await saveHandle(h.db, server.id, next)
    h.runtime.failStops('the provider refused to stop')
    await abandon(op, 'failed', 'failed')
    expect(h.runtime.machine(server.id)?.state).toBe('stopped')
  } finally {
    h.runtime.failStops(null)
    await h.close()
  }
}

describe.skipIf(!hasDatabase)('operation runtime bindings', () => {
  test('records desired configuration and preserves rollback identity', configurations, 30 * SECOND_MS)
  test('saves the booted configuration and schedules eligibility', recordsBoot, 30 * SECOND_MS)
  test('persists progress handles and reports lost kept memory', progress, 30 * SECOND_MS)
  test('retains running handles and saves a changed start address', startsCompute, 30 * SECOND_MS)
  test('refuses a binding owned by a removed provider', foreignProvider, 30 * SECOND_MS)
  test('stops only failed compute and forces a refused stop', failedCompute, 30 * SECOND_MS)
})
