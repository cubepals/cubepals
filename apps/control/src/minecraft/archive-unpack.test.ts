// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The game's shell copy of the archive magic bytes, held to the runtime port's. */
import { expect, test } from 'bun:test'
import { GZIP_MAGIC, ZSTD_MAGIC } from '../app/ports/runtime.ts'
import { GZIP_MAGIC_HEX, ZSTD_MAGIC_HEX } from './archive-unpack.ts'

const hex = (bytes: readonly number[]) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')

test('the shell tells gzip and zstd apart by the same bytes the runtime port names', () => {
  expect(GZIP_MAGIC_HEX).toBe(hex(GZIP_MAGIC))
  expect(ZSTD_MAGIC_HEX).toBe(hex(ZSTD_MAGIC))
})
