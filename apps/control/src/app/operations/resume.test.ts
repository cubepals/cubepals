// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A ready game outruns stale provider state; both losing waits are cancelled and hangs still recover. */
import { expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import type { GameEndpoint, ReadinessProbe } from '../ports/minecraft.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import { Resume } from './resume.ts'
import type { OperationContext } from './runner.ts'

const handle = 'resuming-machine' as RuntimeHandle
const endpoint: GameEndpoint = { host: 'resuming.test', port: 25565, proxyProtocol: true }
const answer = { online: 0, max: 10, version: '1.21.4' }

function fixture(
  ping: ReadinessProbe['ping'],
  reportsRunning = false,
  resumeMs = SECOND_MS,
  beforeObserving?: () => Promise<void>,
) {
  const seen = { marks: [] as string[], forced: 0, starts: 0, providerCancelled: false }
  const resume = new Resume({
    runtime: {
      waitRunning: async (_handle, signal) => {
        if (reportsRunning) return
        if (signal.aborted) {
          seen.providerCancelled = true
          throw signal.reason
        }
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              seen.providerCancelled = true
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
      forceStop: async () => {
        seen.forced++
      },
      start: async (value) => {
        seen.starts++
        return value
      },
    },
    probe: { ping },
    logs: { recent: async () => [], tail: async function* () {} },
    resumeMs,
  })
  const ctx = {
    op: { id: 'resume-test', kind: 'start' },
    mark: async (mark: string) => {
      seen.marks.push(mark)
      if (mark === 'resume_observing') await beforeObserving?.()
    },
  } as OperationContext
  return {
    seen,
    run: async () => {
      const pending = Symbol('operation still pending')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          resume.cameBack(ctx, handle, () => endpoint),
          new Promise<symbol>((resolve) => {
            timer = setTimeout(() => resolve(pending), 500)
          }),
        ])
        // A readiness call must actually finish. A test-framework timeout proves no assertion.
        expect(result).not.toBe(pending)
        return result as boolean
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

test('an answering game releases a join before its provider reports running', async () => {
  const targets: GameEndpoint[] = []
  const { run, seen } = fixture(async (target) => {
    targets.push(target)
    return answer
  })
  expect(await run()).toBe(true)
  expect(targets).toEqual([endpoint])
  expect(seen).toEqual({
    marks: ['resume_observing', 'resume_answered'],
    forced: 0,
    starts: 0,
    providerCancelled: true,
  })
})

test('a refused early connection is retried while the provider status remains behind', async () => {
  let attempts = 0
  const { run, seen } = fixture(async () => {
    if (++attempts === 1) throw new Error('not answering yet')
    return answer
  })
  expect(await run()).toBe(true)
  expect(attempts).toBe(2)
  expect(seen).toEqual({
    marks: ['resume_observing', 'resume_answered'],
    forced: 0,
    starts: 0,
    providerCancelled: true,
  })
})

test('a provider that finishes first cancels the pending connection before the normal ready check', async () => {
  let attempts = 0,
    cancelled = false
  const { run, seen } = fixture(async (_target, signal) => {
    if (++attempts > 1) return answer
    return new Promise((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled = true
          reject(signal.reason)
        },
        { once: true },
      )
    })
  }, true)
  expect(await run()).toBe(true)
  expect(cancelled).toBe(true)
  expect(attempts).toBe(2)
  expect(seen.forced).toBe(0)
  expect(seen.marks).toEqual(['resume_observing', 'resume_running', 'resume_answered'])
})

test('a machine that neither runs nor answers still receives the bounded cold-start fallback', async () => {
  const { run, seen } = fixture(
    async () => {
      throw new Error('not answering')
    },
    false,
    20,
  )
  expect(await run()).toBe(false)
  expect(seen).toEqual({
    marks: ['resume_observing', 'resume_hung'],
    forced: 1,
    starts: 1,
    providerCancelled: true,
  })
})

test('an observation whose deadline already ended opens no game connection', async () => {
  let pings = 0
  const { run, seen } = fixture(
    async () => {
      pings++
      return answer
    },
    false,
    20,
    async () => {
      await Bun.sleep(40)
    },
  )
  expect(await run()).toBe(false)
  expect(pings).toBe(0)
  expect(seen).toEqual({
    marks: ['resume_observing', 'resume_hung'],
    forced: 1,
    starts: 1,
    providerCancelled: true,
  })
})
