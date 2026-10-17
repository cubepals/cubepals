// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/api/health` says whether the control plane can do its work, not only that the process
 * answers: one that can read nothing it depends on is not healthy. A scheduled workflow polls it
 * from outside, so a worker that is down is heard of while nothing inside runs.
 */
import { describe, expect, spyOn, test } from 'bun:test'
import type { Services } from '../trpc/trpc.ts'
import { createApiApp } from './api.ts'

/** The api with only these services behind it: no database, no job queue. */
const apiWith = (services: Partial<Services>) =>
  createApiApp({
    auth: {
      handle: async () => new Response(null, { status: 404 }),
      sessionOf: async () => null,
      switchFor: () => ({ impersonate: async () => {}, stopImpersonating: async () => {} }),
    },
    methods: { google: false, github: false, turnstileSiteKey: null },
    addresses: { proxySecret: null, hostHeader: null },
    origins: ['https://blockly.test'],
    services: services as unknown as Services,
  } as unknown as Parameters<typeof createApiApp>[0])

/** A health service answering what the worker's sweeps would. */
const sweeps = (stale: string[]) =>
  ({ liveness: async () => ({ ok: stale.length === 0, stale }) }) as unknown as Services['health']

describe('the control plane’s health check', () => {
  test('is not healthy when it can reach nothing it depends on', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    const response = await Promise.resolve(apiWith({}).request('/api/health')).finally(() =>
      quiet.mockRestore(),
    )
    expect(response.status).toBeGreaterThanOrEqual(500)
  })

  test('is healthy while the key sweeps are recent, and names those that are not', async () => {
    expect((await apiWith({ health: sweeps([]) }).request('/api/health')).status).toBe(200)
    const stale = await apiWith({ health: sweeps(['worker-heartbeat']) }).request('/api/health')
    expect(stale.status).toBe(503)
    expect(await stale.json()).toEqual({ ok: false, stale: ['worker-heartbeat'] })
  })

  test('that Fly asks of the api answers whatever the worker is doing', async () => {
    const response = await apiWith({ health: sweeps(['worker-heartbeat']) }).request('/api/health/live')
    expect(response.status).toBe(200)
  })
})
