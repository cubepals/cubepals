// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An owner's own server icon as the page sends it: kept as its pixels alone, and refused unless it
 * is a 64 square PNG, by its header before any of it is decoded.
 */
import { describe, expect, spyOn, test } from 'bun:test'
import { crc32 } from 'node:zlib'
import { OWN_ICON_MAX_BYTES } from '@blockly/contracts'
import { PNG } from 'pngjs'
import { ownIcon } from './own-icon.ts'

const picture = (width = 64, height = 64) => {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) png.data.set([i % 256, 80, 200, 255], i)
  return PNG.sync.write(png)
}
const refusal = (sent: Uint8Array) => {
  try {
    ownIcon(sent)
    return 'none'
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('an owner’s own icon', () => {
  test('is kept as its pixels alone, named by its bytes', () => {
    const sent = picture()
    // Text carried in the file, just before its end, is something a server and a page never see.
    const text = Buffer.concat([Buffer.from('tEXt'), Buffer.from('Comment\0hello')])
    const chunk = Buffer.alloc(text.length + 8)
    chunk.writeUInt32BE(text.length - 4, 0)
    text.copy(chunk, 4)
    chunk.writeUInt32BE(crc32(text), text.length + 4)
    const end = sent.length - 12
    const kept = ownIcon(Buffer.concat([sent.subarray(0, end), chunk, sent.subarray(end)]))
    expect(kept.png.includes(Buffer.from('hello'))).toBe(false)
    expect(PNG.sync.read(kept.png).data).toEqual(PNG.sync.read(sent).data)
    expect(kept.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(ownIcon(sent).sha256).toBe(kept.sha256)
  })

  test('refuses what isn’t a 64 square PNG', () => {
    expect(refusal(Buffer.from('\xff\xd8\xff\xe0 a JPEG, not drawn yet'))).toBe('invalid_choice')
    expect(refusal(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('invalid_choice')
    expect(refusal(picture(65, 64))).toBe('invalid_choice')
    expect(refusal(picture(32, 32))).toBe('invalid_choice')
    expect(refusal(new Uint8Array(OWN_ICON_MAX_BYTES + 1))).toBe('invalid_choice')
  })

  test('refuses one whose header says another size before decoding any of it', () => {
    // A 64 square PNG whose header is rewritten to say 4096 square, its checksum made again.
    const sent = Buffer.from(picture())
    sent.writeUInt32BE(4096, 16)
    sent.writeUInt32BE(4096, 20)
    sent.writeUInt32BE(crc32(sent.subarray(12, 29)), 29)
    const read = spyOn(PNG.sync, 'read')
    try {
      expect(refusal(sent)).toBe('invalid_choice')
      expect(read).not.toHaveBeenCalled()
      expect(refusal(picture())).toBe('none')
      expect(read).toHaveBeenCalledTimes(1)
    } finally {
      read.mockRestore()
    }
  })
})
