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
  // The size its header says, read before any pixel is inflated: the decoder sizes its buffers by it.
  const { width, height } = headerSize(sent) ?? { width: 0, height: 0 }
  if (width !== OWN_ICON_SIZE || height !== OWN_ICON_SIZE) throw refused
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

/** A PNG's signature, then its first chunk, which must be IHDR (PNG specification, §5.2 and §11.2.2). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = Buffer.from('IHDR', 'latin1')

/** The width and height a PNG's IHDR chunk gives, or null for what doesn't start as a PNG does. */
function headerSize(sent: Uint8Array): { width: number; height: number } | null {
  const bytes = Buffer.from(sent.buffer, sent.byteOffset, sent.byteLength)
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (!bytes.subarray(12, 16).equals(IHDR)) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
