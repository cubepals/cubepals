// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** File-format failures retain the detail and limit that their real callers explain to players. */
import { expect, test } from 'bun:test'
import { DownloadRefused, HostileArchive, ReadCutShort, UnreadableFile } from './formats.ts'

for (const Failure of [DownloadRefused, UnreadableFile]) {
  test(`${Failure.name} retains its identity and detail`, () => {
    const error = new Failure('The input could not be read')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(Failure.name)
    expect(error.message).toBe('The input could not be read')
  })
}

test('a hostile archive preserves the reason and explanation', () => {
  const error = new HostileArchive('unsafe_name', 'The entry escapes its folder')
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('HostileArchive')
  expect(error.reason).toBe('unsafe_name')
  expect(error.message).toBe('The entry escapes its folder')
})

test('a bounded read remains an unreadable file and identifies its actual limit', () => {
  for (const limit of ['kept', 'size', 'time'] as const) {
    const error = new ReadCutShort(limit, 'The archive exceeded its limit')
    expect(error).toBeInstanceOf(UnreadableFile)
    expect(error.name).toBe('ReadCutShort')
    expect(error.limit).toBe(limit)
    expect(error.message).toBe('The archive exceeded its limit')
  }
})
