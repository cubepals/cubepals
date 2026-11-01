// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Format errors preserve the classification callers use when refusing an upload or download. */
import { expect, test } from 'bun:test'
import { DownloadRefused, HostileArchive, ReadCutShort, UnreadableFile } from './formats.ts'

test('an unsafe archive retains its reason and the diagnostic that explains the refusal', () => {
  const detail = 'An entry escapes the requested folder'
  const error = new HostileArchive('unsafe_name', detail)
  expect(error).toBeInstanceOf(Error)
  expect(error.reason).toBe('unsafe_name')
  expect(error.message).toBe(detail)
  expect(error.name).toBe(HostileArchive.name)
})

test('a refused download retains its diagnostic and distinct error type', () => {
  const detail = 'The redirect leaves the permitted host'
  const error = new DownloadRefused(detail)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toBe(detail)
  expect(error.name).toBe(DownloadRefused.name)
})

test('an unreadable file retains the parser diagnostic', () => {
  const detail = 'The archive ended before its header'
  const error = new UnreadableFile(detail)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toBe(detail)
  expect(error.name).toBe(UnreadableFile.name)
})

test('a cut-short read remains an unreadable file and retains the limit it exceeded', () => {
  for (const limit of ['kept', 'size', 'time'] as const) {
    const detail = `The ${limit} budget was exhausted`
    const error = new ReadCutShort(limit, detail)
    expect(error).toBeInstanceOf(UnreadableFile)
    expect(error.limit).toBe(limit)
    expect(error.message).toBe(detail)
    expect(error.name).toBe(ReadCutShort.name)
  }
})
