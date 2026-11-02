// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A retained staging refusal passes through Fly's actual HTTP client before the runtime classifies it. */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { constants as HTTP } from 'node:http2'
import { HostFull, RuntimeFull } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { launched } from './fly-runtime/responses.ts'
import { VOLUME_PLACEMENT_CAPACITY_STATUS } from './refusals.ts'

const body = readFileSync(new URL('./fixtures/volume-placement-capacity.json', import.meta.url), 'utf8')

test('a volume placement refusal remains capacity pressure rather than a permanent failure', async () => {
  const endpoint = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(body, {
        status: HTTP.HTTP_STATUS_PRECONDITION_FAILED,
        headers: { 'content-type': 'application/json' },
      }),
  })
  try {
    const client = flyClient('test', { baseUrl: endpoint.url.toString() })
    const result = await client.POST('/v1/apps/{app_name}/machines', {
      params: { path: { app_name: 'capacity-test' } },
      body: {},
    })
    expect(result.error).toMatchObject({ status: VOLUME_PLACEMENT_CAPACITY_STATUS })
    expect(() => launched(result, 'creating the machine')).toThrow(RuntimeFull)
    expect(() => launched(result, 'starting its machine', true)).toThrow(HostFull)
  } finally {
    endpoint.stop(true)
  }
})
