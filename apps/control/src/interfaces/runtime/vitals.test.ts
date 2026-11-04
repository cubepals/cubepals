// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a server's reporter posts how it ticks: its own token wanted, a server that posts too
 * often refused, what isn't a sample refused, and what is kept handed on as it came.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ServerVitals } from '@blockly/contracts/server-vitals'
import { ArtifactForbidden, type ArtifactService } from '../../app/artifacts/service.ts'
import { installTuning, tuning } from '../../app/tuning.ts'
import { createVitalsApp } from './vitals.ts'

const SERVER = '3b1f5c2a-7d4e-4f6a-9b8c-1d2e3f4a5b6c'
const SAMPLE: ServerVitals = {
  at: '2026-11-04T12:00:00.000Z',
  tps: 19.5,
  mspt: 21.2,
  msptP95: 35,
  msptMax: 61,
  players: 4,
  chunks: 1500,
  entities: 420,
  heapUsedMb: 1400,
  heapMaxMb: 3072,
  gcMs: 25,
}

let kept: Array<[string, ServerVitals[]]>
let allowed: boolean
let app: ReturnType<typeof createVitalsApp>

beforeEach(() => {
  kept = []
  allowed = true
  app = createVitalsApp({
    artifacts: {
      authorize: (serverId: string, token: string) => {
        if (serverId !== SERVER || token !== 'good') throw new ArtifactForbidden('wrong token')
      },
    } as unknown as ArtifactService,
    vitals: {
      mayReport: async () => allowed,
      record: async (serverId, samples) => {
        kept.push([serverId, [...samples]])
        return samples.length
      },
    },
  })
})

const post = (body: unknown, { server = SERVER, token = 'good' } = {}) =>
  app.request(`/runtime/v1/servers/${server}/vitals?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('a server’s ticks, as its reporter posts them', () => {
  test('are kept as they came, for the server the token is for', async () => {
    expect((await post({ events: [SAMPLE] })).status).toBe(204)
    expect(kept).toEqual([[SERVER, [SAMPLE]]])
  })

  test('want the server’s own token, and a server id', async () => {
    expect((await post({ events: [SAMPLE] }, { token: 'stolen' })).status).toBe(403)
    expect((await post({ events: [SAMPLE] }, { server: 'not-a-server' })).status).toBe(404)
    expect(kept).toEqual([])
  })

  test('refuse a server posting too often, and what isn’t a sample', async () => {
    expect((await post({ events: [{ ...SAMPLE, tps: -1 }] })).status).toBe(400)
    expect((await post({ samples: [SAMPLE] })).status).toBe(400)
    allowed = false
    expect((await post({ events: [SAMPLE] })).status).toBe(429)
    expect(kept).toEqual([])
  })

  test('refuse more than a request may carry, as the deployment’s ABUSE_LIMITS say', async () => {
    const deployed = tuning()
    const padded = (n: number) => ({ events: [SAMPLE], padding: 'x'.repeat(n) })
    expect((await post(padded(deployed.abuse.vitalsReportBytes))).status).toBe(413)
    installTuning({ ...deployed, abuse: { ...deployed.abuse, vitalsReportBytes: 1_000 } })
    try {
      expect((await post(padded(2_000))).status).toBe(413)
      expect((await post({ events: [SAMPLE] })).status).toBe(204)
    } finally {
      installTuning(deployed)
    }
  })
})
