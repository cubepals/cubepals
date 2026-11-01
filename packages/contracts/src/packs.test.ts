// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Pack uploads and reviewed releases validate the public request contract without app startup. */
import { expect, test } from 'bun:test'
import {
  BeginPackUploadInput,
  ChangePackInput,
  CuratedReleaseInput,
  FinishPackUploadInput,
  PackImportRef,
  WithdrawReleaseInput,
} from './packs.ts'
import { oneLine } from './plain-text.ts'

const serverId = crypto.randomUUID(),
  requestId = crypto.randomUUID()

test('pack uploads normalize filenames and require positive integral byte counts and real tickets', () => {
  const fileName = '  A\npack.zip  '
  expect(BeginPackUploadInput.parse({ fileName, sizeBytes: 1 })).toEqual({
    fileName: oneLine(fileName).trim(),
    sizeBytes: 1,
  })
  expect(BeginPackUploadInput.safeParse({ fileName: 'a'.repeat(255), sizeBytes: 1 }).success).toBe(true)
  for (const patch of [
    { fileName: '' },
    { fileName: ' ' },
    { fileName: 'x'.repeat(256) },
    { sizeBytes: 0 },
    { sizeBytes: -1 },
    { sizeBytes: 0.5 },
  ])
    expect(BeginPackUploadInput.safeParse({ fileName: 'pack.zip', sizeBytes: 1, ...patch }).success).toBe(
      false,
    )
  const ticket = crypto.randomUUID(),
    importId = crypto.randomUUID()
  expect(FinishPackUploadInput.parse({ ticket })).toEqual({ ticket })
  for (const world of [true, false])
    expect(FinishPackUploadInput.parse({ ticket, world })).toEqual({ ticket, world })
  expect(FinishPackUploadInput.safeParse({ ticket: 'bad' }).success).toBe(false)
  expect(FinishPackUploadInput.safeParse({ ticket, world: 'yes' }).success).toBe(false)
  expect(PackImportRef.parse({ importId })).toEqual({ importId })
  expect(PackImportRef.safeParse({ importId: 'bad' }).success).toBe(false)
})

test('changing a pack validates every supported target and concurrency token', () => {
  const base = { serverId, requestId, version: 0 }
  const targets = [
    { kind: 'catalog', versionId: ' release ' },
    { kind: 'curated', version: ' release ' },
    { kind: 'import', importId: crypto.randomUUID() },
  ]
  expect(ChangePackInput.parse({ ...base, to: targets[0] })).toEqual({
    ...base,
    to: { kind: 'catalog', versionId: 'release' },
  })
  expect(ChangePackInput.parse({ ...base, to: targets[1] })).toEqual({
    ...base,
    to: { kind: 'curated', version: 'release' },
  })
  expect(ChangePackInput.safeParse({ ...base, to: targets[2], acknowledgeRevoked: false }).success).toBe(true)
  for (const patch of [
    { serverId: 'bad' },
    { requestId: 'bad' },
    { version: -1 },
    { version: 0.5 },
    { acknowledgeRevoked: 'yes' },
    { to: { kind: 'other' } },
    { to: { kind: 'import', importId: 'bad' } },
  ])
    expect(ChangePackInput.safeParse({ ...base, to: targets[0], ...patch }).success).toBe(false)
  for (const kind of ['catalog', 'curated'])
    for (const value of ['', ' ', 'x'.repeat(65)])
      expect(
        ChangePackInput.safeParse({ ...base, to: { kind, versionId: value, version: value } }).success,
      ).toBe(false)
  for (const kind of ['catalog', 'curated'])
    expect(
      ChangePackInput.safeParse({ ...base, to: { kind, versionId: 'x'.repeat(64), version: 'x'.repeat(64) } })
        .success,
    ).toBe(true)
})

test('curated releases trim their identity and require a bounded withdrawal reason', () => {
  expect(CuratedReleaseInput.parse({ key: ' pack ', version: ' release ' })).toEqual({
    key: 'pack',
    version: 'release',
  })
  expect(WithdrawReleaseInput.parse({ key: 'pack', version: 'release', reason: ' A reason ' })).toEqual({
    key: 'pack',
    version: 'release',
    reason: 'A reason',
  })
  expect(
    WithdrawReleaseInput.safeParse({ key: 'x'.repeat(40), version: 'x'.repeat(64), reason: 'x'.repeat(300) })
      .success,
  ).toBe(true)
  for (const patch of [
    { key: '' },
    { key: 'x'.repeat(41) },
    { version: '' },
    { version: 'x'.repeat(65) },
    { reason: ' ' },
    { reason: 'x'.repeat(301) },
  ])
    expect(
      WithdrawReleaseInput.safeParse({ key: 'pack', version: 'release', reason: 'Reason', ...patch }).success,
    ).toBe(false)
})
