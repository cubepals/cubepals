// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { DAY_S } from '@blockly/contracts/durations'
import { Hono } from 'hono'
import { type BuiltPack, brandPackPath } from '../../app/artifacts/brand-pack.ts'

/**
 * Cubepals' resource pack, served for players' games to download
 * (`app/artifacts/brand-pack.ts`). Its link names its SHA-1, so a game may keep it for as long as
 * it likes.
 */
export function brandPackRoutes(pack: Pick<BuiltPack, 'bytes' | 'sha1'>): Hono {
  const app = new Hono()
  app.get('/api/public/pack/:file', (c) => {
    if (c.req.path !== brandPackPath(pack.sha1)) return c.body(null, 404)
    return c.body(new Uint8Array(pack.bytes), 200, {
      'Content-Type': 'application/zip',
      'Cache-Control': `public, max-age=${365 * DAY_S}, immutable`,
    })
  })
  return app
}
