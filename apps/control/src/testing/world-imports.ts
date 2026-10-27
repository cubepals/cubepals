// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world upload taken to where it ends, as a test waits on one: begun, sent to the store,
 * finished, and waited on while a worker reads it (`app/backups/world-imports.ts`).
 */
import type { WorldImportView } from '@blockly/contracts'
import type { UserActor } from '../app/actor.ts'
import { type BackupRecord, loadBackup } from '../app/backups/persistence.ts'
import type { Harness } from './harness.ts'

/** Waits for an import to be read, until it asks, is ready or is refused. */
export async function untilRead(
  h: Pick<Harness, 'app'>,
  owner: UserActor,
  serverId: string,
  importId: string,
  timeoutMs = 60_000,
): Promise<WorldImportView> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const view = await h.app.backups.imports.view(owner, serverId, importId)
    if (view.status !== 'reading') return view
    if (Date.now() > until)
      throw new Error(`The import ${importId} was still being read after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Sends `bytes` as a world upload named `fileName`, and waits for it to be read. */
export async function bringWorld(
  h: Pick<Harness, 'app'>,
  owner: UserActor,
  serverId: string,
  bytes: Uint8Array,
  options: { fileName?: string; name?: string } = {},
): Promise<WorldImportView> {
  const start = await h.app.backups.beginWorldUpload(owner, serverId, {
    fileName: options.fileName ?? 'world.tar.gz',
    sizeBytes: bytes.length,
  })
  const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
  if (!put.ok) throw new Error(`The store answered ${put.status} to the upload`)
  const { importId } = await h.app.backups.finishWorldUpload(owner, serverId, start.ticket, options.name)
  return untilRead(h, owner, serverId, importId)
}

/** The backup a world upload became; it throws with what its owner was told, where it wasn't kept. */
export async function broughtBackup(h: Pick<Harness, 'db'>, view: WorldImportView): Promise<BackupRecord> {
  if (view.status === 'refused') throw new Error(view.message)
  if (view.status !== 'ready') throw new Error(`The import is ${view.status}`)
  const backup = await loadBackup(h.db, view.backupId)
  if (backup === null) throw new Error(`The backup ${view.backupId} is missing`)
  return backup
}
