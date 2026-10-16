// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { brandPackPath } from '../../app/artifacts/brand-pack.ts'
import { brandPackRoutes } from './brand-pack.ts'

describe("Cubepals' resource pack's link", () => {
  const pack = { bytes: new Uint8Array([80, 75, 5, 6]), sha1: 'a'.repeat(40) }
  const app = brandPackRoutes(pack)

  test('it answers with the pack, as a zip a game may keep, at the link naming its SHA-1', async () => {
    const response = await app.request(brandPackPath(pack.sha1))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pack.bytes)
  })

  test('a link naming any other pack finds nothing', async () => {
    expect((await app.request(brandPackPath('b'.repeat(40)))).status).toBe(404)
    expect((await app.request(`/api/public/pack/${pack.sha1}`)).status).toBe(404)
  })
})
