// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import { OWN_ICON_MAX_BYTES, OWN_ICON_SIZE } from '@blockly/contracts'
import { PNG } from 'pngjs'
import { AppError } from '../../app/errors.ts'

/**
 * The page crops and shrinks the owner's picture before sending it, so what arrives must already
 * be a 64 square PNG. It is decoded and drawn again from its pixels alone, so nothing else that
 * came with the file (text, colour profiles, trailing bytes) reaches a server or a page.
 */
export function ownIcon(sent: Uint8Array): { png: Buffer; sha256: string } {
  const refused = new AppError('invalid_choice', 'That picture can’t be used. Try another.')
  if (sent.byteLength > OWN_ICON_MAX_BYTES) throw refused
  let decoded: PNG
  try {
    decoded = PNG.sync.read(Buffer.from(sent))
  } catch {
    throw refused
  }
  if (decoded.width !== OWN_ICON_SIZE || decoded.height !== OWN_ICON_SIZE) throw refused
  const drawn = new PNG({ width: OWN_ICON_SIZE, height: OWN_ICON_SIZE })
  drawn.data.set(decoded.data)
  const png = PNG.sync.write(drawn)
  return { png, sha256: createHash('sha256').update(png).digest('hex') }
}
