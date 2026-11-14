// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { bedrockProbe } from './bedrock-client.ts'

test('a join probe asks GET /v1/join and gives back what the server said', async () => {
  const asked: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      asked.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json({ motd: 'Cubepals' })
    },
  })
  try {
    expect(await bedrockProbe(`http://127.0.0.1:${server.port}`)).toBe('200 {"motd":"Cubepals"}')
    expect(asked).toEqual(['GET /v1/join'])
  } finally {
    server.stop(true)
  }
})

test('a probe the server refuses fails with where it asked and what it answered', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('no', { status: 503 }),
  })
  try {
    await expect(bedrockProbe(`http://127.0.0.1:${server.port}`)).rejects.toThrow(
      `http://127.0.0.1:${server.port}/v1/join answered 503: no`,
    )
  } finally {
    server.stop(true)
  }
})
