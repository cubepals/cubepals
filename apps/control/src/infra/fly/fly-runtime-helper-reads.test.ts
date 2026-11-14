// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A helper's job outlives a read of it that fails. `helperJob` reads again, gives the job up only
 * once reads have failed for as long as it is told to bear, with the last read's error, and still
 * stops at once when aborted. Run against the in-memory Fly, which refuses a read as Fly refused
 * one; what the jobs do is `helper-jobs.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { until } from '@blockly/contracts/waits'
import type { RuntimeKey } from '../../app/ports/runtime.ts'
import { FlyApiError, flyClient } from './client.ts'
import { FakeFly, NO_CHILD_SAID } from './fake-fly.ts'
import { appName, ensureApp } from './fly-runtime/apps.ts'
import { helperJob, JOB_READS, job } from './fly-runtime/helper-machine.ts'
import { idOf } from './fly-runtime/responses.ts'
import { createVolume, EXPORT_VOLUME_NAME } from './fly-runtime/volumes.ts'
import { META } from './machine-config.ts'

const KEY = '4b8e2d6a-9c1f-4a3e-b7d5-0e6f8a2c4b19' as RuntimeKey
const APP = appName('test', KEY)
const SCRIPT = job('tar -czf /data/world.tgz -C /data world')
/** Reads a millisecond apart, so no test waits a second for the next one. */
const QUICK = { ...JOB_READS, quickMs: 1, slowMs: 1 }

/** An app with one volume for a helper to mount, on a fresh in-memory Fly. */
async function onVolume() {
  const fake = new FakeFly()
  const fly = flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } })
  await ensureApp(fly, 'blockly', 'test', APP, KEY)
  const volume = await createVolume(fly, APP, { name: EXPORT_VOLUME_NAME, region: 'fra', size_gb: 1 }, 30)
  const run = (reads = QUICK, signal?: AbortSignal) =>
    helperJob(fly, 'test', APP, 'fra', idOf(volume, 'a volume'), SCRIPT, signal, reads)
  return { fake, run }
}

const isHelper = (machine: { config: { metadata?: unknown } }) =>
  (machine.config.metadata as Record<string, string>)[META.role] === 'helper'
const helpersLeft = (fake: FakeFly) => (fake.machines.get(APP) ?? []).filter(isHelper).map((m) => m.id)
const helpersDestroyed = (fake: FakeFly) => fake.destroyed.filter(isHelper).map((m) => m.id)
/** The commands Fly was asked to run: the first starts the job, each one after reads it. */
const commands = (fake: FakeFly) => fake.calls.filter((call) => call.endsWith('/exec')).length

describe('FlyRuntime reading a helper job', () => {
  let warn: ReturnType<typeof spyOn>
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })
  const warned = () => warn.mock.calls.map((said: unknown[]) => String(said[0]))

  test('a read Fly refuses is read again, and the job gives its result', async () => {
    const { fake, run } = await onVolume()
    fake.jobReads.push('refused')

    expect(await run()).toBe('0123abcd 4096')

    expect(commands(fake)).toBe(3)
    const [helper = 'none', ...others] = helpersDestroyed(fake)
    expect(others).toEqual([])
    // Destroyed once, and only after the read that answered.
    const machine = `/v1/apps/${APP}/machines/${helper}`
    expect(fake.count(`DELETE ${machine}`)).toBe(1)
    expect(fake.calls.indexOf(`DELETE ${machine}`)).toBeGreaterThan(
      fake.calls.lastIndexOf(`POST ${machine}/exec`),
    )
    expect(helpersLeft(fake)).toEqual([])
    // Said once, naming the app and the machine, and nothing of the script, which holds links.
    expect(warned()).toHaveLength(1)
    expect(warned()[0]).toContain(APP)
    expect(warned()[0]).toContain(helper)
    expect(warned()[0]).not.toContain('world.tgz')
  })

  test('a read that answers between two refused starts the count again', async () => {
    const { fake, run } = await onVolume()
    fake.jobReads.push('refused', 'running', 'refused')

    // Each pause outlasts what reads may fail for: counted from the first refusal, the second
    // would end the job.
    expect(await run({ quickMs: 30, slowMs: 30, failingMs: 20 })).toBe('0123abcd 4096')

    expect(commands(fake)).toBe(5)
    expect(warned()).toHaveLength(2)
    expect(helpersLeft(fake)).toEqual([])
  })

  test('reads refused for as long as it bears end the job with what Fly said, its helper destroyed', async () => {
    const { fake, run } = await onVolume()
    fake.jobReads.push('lost')

    const failed = await run({ ...QUICK, failingMs: 20 }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(failed).toBeInstanceOf(FlyApiError)
    expect(String(failed)).toContain(NO_CHILD_SAID)
    // The first refusal alone ends nothing.
    expect(commands(fake)).toBeGreaterThan(2)
    expect(helpersDestroyed(fake)).toHaveLength(1)
    expect(helpersLeft(fake)).toEqual([])
  })

  test('aborted while its reads are refused, it stops at once with why, its helper destroyed', async () => {
    const { fake, run } = await onVolume()
    fake.jobReads.push('lost')
    const taken = new AbortController()

    // A minute of refused reads is borne: only the abort ends this one inside the test's time.
    const outcome = run(QUICK, taken.signal).then(
      () => 'finished',
      (error: unknown) => String(error),
    )
    await until('a second refused read', () => commands(fake) >= 3, {
      seen: () => `${commands(fake)} commands`,
      timeoutMs: 3 * SECOND_MS,
    })
    taken.abort(new Error('taken over'))

    expect(await outcome).toContain('taken over')
    expect(helpersDestroyed(fake)).toHaveLength(1)
    expect(helpersLeft(fake)).toEqual([])
  })
})
