// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { S3ArchiveStore } from './s3-archive-store.ts'

// An archive's key is the store's to issue (§4); this store lays them out by server.
describe('S3 archive keys', () => {
  const store = new S3ArchiveStore({
    endpoint: 'http://127.0.0.1:1',
    bucket: 'b',
    region: 'auto',
    accessKeyId: 'k',
    secretAccessKey: 's',
  })

  test('archives and uploads live under their server; staged mods on their own', () => {
    const scope = { serverId: 'srv', id: 'x1' }
    expect(store.newKey('archive', scope)).toBe('archives/srv/x1.tar.gz')
    expect(store.newKey('world_upload', scope)).toBe('archives/srv/uploads/x1.tar.gz')
    expect(store.newKey('mod_upload', scope)).toBe('uploads/staging/x1')
  })
})
