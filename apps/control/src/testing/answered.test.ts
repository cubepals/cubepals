// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Exercise the real HTTP router without browser retries hiding a broken test transport. */
import { expect, test } from 'bun:test'
import { answered } from './answered.ts'

test('queries and mutations reach nested services with an authenticated actor and original input', async () => {
  const serverId = crypto.randomUUID()
  const importId = crypto.randomUUID()
  const ticket = crypto.randomUUID()
  const calls: Array<{ service: string; method: string; args: unknown[] }> = []
  const fetch = answered((service, method, args) => {
    calls.push({ service, method, args })
    return { importId }
  })
  const input = new URLSearchParams({ input: JSON.stringify({ serverId, importId }) })
  const response = await fetch(new URL(`http://localhost/api/trpc/backups.upload?${input}`))
  expect(response.ok).toBe(true)
  expect(await response.text()).toContain(importId)
  const saved = await fetch('http://localhost/api/trpc/backups.finishUpload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId, ticket, name: 'Life' }),
  })
  expect(saved.ok).toBe(true)
  expect(await saved.text()).toContain(importId)
  expect(calls.map(({ service, method }) => [service, method])).toEqual([
    ['backups', 'imports.view'],
    ['backups', 'finishWorldUpload'],
  ])
  expect(calls[0]?.args.slice(1)).toEqual([serverId, importId])
  expect(calls[1]?.args.slice(1)).toEqual([serverId, ticket, 'Life'])
  for (const call of calls) {
    expect(call.args[0]).toMatchObject({ kind: 'user' })
    expect((call.args[0] as { userId: string }).userId).toBeString()
  }
})
