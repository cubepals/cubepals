// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Native checks and player starts require the same retained, carried and learned pack files. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { PackContentsRecord } from './persistence.ts'
import { packInstallCheck } from './startup-evidence.ts'

const jar = (path: string) => ({
  path,
  sha512: createHash('sha512').update(path).digest('hex'),
  sizeBytes: 1,
})
const server = jar('mods/server.jar'),
  excluded = jar('mods/excluded.jar'),
  carried = jar('plugins/bridge.jar'),
  needed = jar('mods/dependency.jar')
const pack: PinnedModpack = {
  catalog: 'upload',
  projectId: 'pack',
  versionId: '1',
  name: 'Pack',
  versionLabel: '1',
  page: null,
  environment: 'both',
  icon: null,
  leaveOut: [excluded.path],
  artifact: {
    ref: { kind: 'stored', key: 'pack.mrpack' },
    sha512: jar('pack').sha512,
    fileName: 'pack.mrpack',
    sizeBytes: 1,
  },
}
const contents: PackContentsRecord = {
  sha512: pack.artifact.sha512,
  name: pack.name,
  versionLabel: pack.versionLabel,
  gameVersion: '26.3',
  loader: 'fabric',
  loaderVersion: '0.19.5',
  playersNeedIt: true,
  memoryMb: null,
  jars: [server, excluded],
  otherJars: [carried],
  leftOut: [
    { path: needed.path, sha512: needed.sha512, why: 'needed' },
    { path: 'mods/no-digest.jar', why: 'needed' },
    { path: 'mods/player-only.jar', sha512: jar('player').sha512, why: 'players' },
  ],
}

test('only verified needed entries join ordinary and carried files; explicit exclusions stay excluded', () => {
  const check = packInstallCheck(contents, pack)
  expect(check?.expected.map(({ path, sha512 }) => [path, sha512])).toEqual(
    [server, carried, needed].map(({ path, sha512 }) => [path, sha512]),
  )
})

test('a pack without exclusions retains its files and an empty pack has no file check', () => {
  const { leaveOut: _excluded, ...unrestricted } = pack
  const plain = { ...contents, leftOut: [] }
  expect(packInstallCheck(plain, unrestricted)?.expected.map((file) => file.path)).toEqual(
    [server, excluded, carried].map((file) => file.path),
  )
  expect(packInstallCheck({ ...plain, jars: [], otherJars: [] }, unrestricted)).toBeNull()
})
