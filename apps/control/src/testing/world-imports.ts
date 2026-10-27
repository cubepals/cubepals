// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world upload taken to where it ends, as a test waits on one: begun, sent to the store,
 * finished, and waited on while a worker reads it (`app/backups/world-imports.ts`), to a server or
 * for a server being made (`new-world-imports.ts`); and the worlds real servers saved, as files to
 * upload (`minecraft/world-fixtures/`).
 */
import { readFile } from 'node:fs/promises'
import type { NewWorldImportView, WorldImportView } from '@blockly/contracts'
import type { UserActor } from '../app/actor.ts'
import { type BackupRecord, loadBackup } from '../app/backups/persistence.ts'
import type { Harness } from './harness.ts'
import { withHost } from './uploads.ts'

const FIXTURES = `${import.meta.dir}/../minecraft/world-fixtures`
/** A player's file Minecraft 1.20.1 wrote, to stand in for a single-player host's data. */
export const PLAYER = `${import.meta.dir}/../minecraft/player-fixtures/1.20.1/player.dat`

/** A real server's folder as files: its own small files as it wrote them, the rest as stand-ins. */
export async function serverFolder(server: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  for (const path of (await readFile(`${FIXTURES}/${server}/files.txt`, 'utf8')).trim().split('\n'))
    files[path] = await readFile(`${FIXTURES}/${server}/${path}`).catch(() =>
      new TextEncoder().encode(`${server} ${path}`),
    )
  return files
}

/** One world of a server's folder as its own save: its files, under `folder`. */
export async function save(folder: string, host = false): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(await serverFolder('vanilla-1.21.11')))
    if (path.startsWith('world/')) files[`${folder}${path.slice('world/'.length)}`] = bytes
  if (host)
    files[`${folder}level.dat`] = await withHost(
      files[`${folder}level.dat`] as Uint8Array,
      await readFile(PLAYER),
    )
  return files
}

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

/** Waits for a world brought for a new server to be read, until it asks, is ready or is refused. */
export async function untilNewRead(
  h: Pick<Harness, 'app'>,
  owner: UserActor,
  importId: string,
  timeoutMs = 60_000,
): Promise<NewWorldImportView> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const view = await h.app.backups.newWorlds.view(owner, importId)
    if (view.status !== 'reading') return view
    if (Date.now() > until)
      throw new Error(`The import ${importId} was still being read after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Sends `bytes` as a world for a server not yet made, and waits for it to be read. */
export async function bringNewWorld(
  h: Pick<Harness, 'app'>,
  owner: UserActor,
  bytes: Uint8Array,
  fileName = 'world.zip',
): Promise<NewWorldImportView> {
  const start = await h.app.backups.newWorlds.begin(owner, { fileName, sizeBytes: bytes.length })
  const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
  if (!put.ok) throw new Error(`The store answered ${put.status} to the upload`)
  const { importId } = await h.app.backups.newWorlds.finish(owner, start.ticket)
  return untilNewRead(h, owner, importId)
}
