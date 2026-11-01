// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Mod plans and upload tickets validate their own inputs directly, without starting an app. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  ApplyModChangeInput,
  BeginModUploadInput,
  FinishModUploadInput,
  ModChangeInput,
  ModSearchInput,
  ModSelection,
  ModUploadRef,
  PlanVersionInput,
} from './mods.ts'
import { oneLine } from './plain-text.ts'
import { Loader } from './server.ts'

const serverId = crypto.randomUUID()
const sha512 = createHash('sha512').update('Fixture mod bytes').digest('hex')

test('a selection trims identifiers and distinguishes an omitted version from an empty one', () => {
  expect(ModSelection.parse({ projectId: ' project ' })).toEqual({ projectId: 'project' })
  expect(ModSelection.parse({ projectId: ' project ', versionId: ' version ' })).toEqual({
    projectId: 'project',
    versionId: 'version',
  })
  for (const field of ['projectId', 'versionId'] as const) {
    for (const value of ['', ' ', 'x'.repeat(65)])
      expect(ModSelection.safeParse({ projectId: 'project', [field]: value }).success).toBe(false)
    expect(ModSelection.safeParse({ projectId: 'project', [field]: 'x'.repeat(64) }).success).toBe(true)
  }
})

test('a mod change retains optional operations, trims their targets and bounds every list', () => {
  expect(ModChangeInput.parse({ serverId })).toEqual({ serverId })
  expect(
    ModChangeInput.parse({ serverId, remove: [' mod '], upgrade: [' project '], moveTo: ' 26.2 ' }),
  ).toEqual({ serverId, remove: ['mod'], upgrade: ['project'], moveTo: '26.2' })
  expect(ModChangeInput.parse({ serverId, upgrade: 'all' }).upgrade).toBe('all')
  for (const [field, value, most] of [
    ['add', { projectId: 'project' }, 50],
    ['addUploads', crypto.randomUUID(), 20],
    ['remove', 'mod', 200],
    ['upgrade', 'project', 200],
  ] as const) {
    expect(ModChangeInput.safeParse({ serverId, [field]: Array(most).fill(value) }).success).toBe(true)
    expect(ModChangeInput.safeParse({ serverId, [field]: Array(most + 1).fill(value) }).success).toBe(false)
  }
  for (const patch of [
    { serverId: 'bad' },
    { addUploads: ['bad'] },
    { remove: [''] },
    { remove: ['x'.repeat(81)] },
    { upgrade: [''] },
    { upgrade: ['x'.repeat(65)] },
    { upgrade: 'other' },
    { moveTo: '' },
    { moveTo: 'x'.repeat(21) },
  ])
    expect(ModChangeInput.safeParse({ serverId, ...patch }).success).toBe(false)
  expect(
    ModChangeInput.safeParse({
      serverId,
      remove: ['x'.repeat(80)],
      upgrade: ['x'.repeat(64)],
      moveTo: 'x'.repeat(20),
    }).success,
  ).toBe(true)
})

test('applying a shown plan requires its request and canonical hashes', () => {
  const input = { serverId, requestId: crypto.randomUUID(), expected: [sha512], acknowledgeRevoked: false }
  expect(ApplyModChangeInput.parse(input)).toEqual(input)
  expect(
    ApplyModChangeInput.safeParse({ serverId, requestId: input.requestId, expected: Array(400).fill(sha512) })
      .success,
  ).toBe(true)
  for (const patch of [
    { requestId: 'bad' },
    { expected: [sha512.toUpperCase()] },
    { expected: [createHash('sha256').update('bytes').digest('hex')] },
    { expected: Array(401).fill(sha512) },
    { acknowledgeRevoked: 'yes' },
  ])
    expect(ApplyModChangeInput.safeParse({ ...input, ...patch }).success).toBe(false)
})

test('search and version plans validate their bounds and preserve defaults', () => {
  expect(ModSearchInput.parse({ serverId, text: ' query ' })).toEqual({ serverId, text: 'query', offset: 0 })
  expect(ModSearchInput.safeParse({ serverId, text: '', offset: 10_000 }).success).toBe(true)
  expect(ModSearchInput.safeParse({ serverId, text: 'x'.repeat(100) }).success).toBe(true)
  for (const patch of [{ offset: -1 }, { offset: 0.5 }, { offset: 10_001 }, { text: 'x'.repeat(101) }])
    expect(ModSearchInput.safeParse({ serverId, text: '', ...patch }).success).toBe(false)
  for (const loader of Loader.options)
    expect(PlanVersionInput.parse({ serverId, loader, gameVersion: ' 26.2 ' })).toEqual({
      serverId,
      loader,
      gameVersion: '26.2',
    })
  for (const patch of [{ loader: 'unknown' }, { gameVersion: '' }, { gameVersion: 'x'.repeat(21) }])
    expect(
      PlanVersionInput.safeParse({ serverId, loader: Loader.options[0], gameVersion: '26.2', ...patch })
        .success,
    ).toBe(false)
})

test('uploads normalize a filename and validate bytes, digests and ticket identifiers', () => {
  const name = '  New\njar.jar  '
  const input = { serverId, fileName: name, sizeBytes: 1, sha512 }
  expect(BeginModUploadInput.parse(input)).toEqual({ ...input, fileName: oneLine(name).trim() })
  expect(BeginModUploadInput.safeParse({ ...input, fileName: 'x'.repeat(255) }).success).toBe(true)
  for (const patch of [
    { fileName: '' },
    { fileName: ' ' },
    { fileName: 'x'.repeat(256) },
    { sizeBytes: 0 },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sha512: 'bad' },
  ])
    expect(BeginModUploadInput.safeParse({ ...input, ...patch }).success).toBe(false)
  const uploadId = crypto.randomUUID(),
    ticket = crypto.randomUUID()
  expect(ModUploadRef.parse({ serverId, uploadId })).toEqual({ serverId, uploadId })
  expect(FinishModUploadInput.parse({ serverId, ticket })).toEqual({ serverId, ticket })
  expect(ModUploadRef.safeParse({ serverId, uploadId: 'bad' }).success).toBe(false)
  expect(FinishModUploadInput.safeParse({ serverId, ticket: 'bad' }).success).toBe(false)
})
