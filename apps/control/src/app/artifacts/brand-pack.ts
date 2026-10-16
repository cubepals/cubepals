// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import { BRAND_PACK } from '../../minecraft/brand-pack.ts'
import type { FileFormats } from '../ports/formats.ts'

/**
 * Cubepals' resource pack as players' games download it (`minecraft/brand-pack.ts`): one zip, its
 * pictures as PNGs, and the SHA-1 a server's properties name it by, made once as the control plane
 * starts. The same files always make the same bytes, so every process serves the same pack, and
 * the hash changes only when the pack does.
 *
 * It is served on the site's own address, under /api/public, which reaches the control plane as
 * the rest of /api does; its link names its SHA-1, so a link is only ever the pack it was made for.
 */
export interface BuiltPack {
  bytes: Uint8Array
  sha1: string
  /** Where a player's game downloads it. */
  url: string
}

/** The pack's path on the site, by its SHA-1. */
export const brandPackPath = (sha1: string): string => `/api/public/pack/${sha1}.zip`

export function buildBrandPack(formats: Pick<FileFormats, 'png' | 'zipped'>, webOrigin: string): BuiltPack {
  const bytes = formats.zipped(
    BRAND_PACK.map((file) => ({
      name: file.path,
      data:
        'json' in file
          ? new TextEncoder().encode(`${JSON.stringify(file.json, null, 2)}\n`)
          : formats.png(file.picture),
    })),
  )
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  return { bytes, sha1, url: `${webOrigin.replace(/\/$/, '')}${brandPackPath(sha1)}` }
}
