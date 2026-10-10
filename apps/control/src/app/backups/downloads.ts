// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * World downloads (§15.5): what an archive's owner downloads, made from the archive on a worker
 * and kept in the store a day for the link to point at. The archive is the server's whole disk,
 * kept that way for restores; the copy holds what is the owner's to take (`minecraft/
 * world-download.ts`) and a note naming the mods it left out. A copy ready for an archive is
 * handed out again rather than made twice. The backups sweep erases copies past their day and
 * those of archives that are gone (`BackupService.eraseArchives`). It is not where archives are
 * made, kept or restored.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Db, schema, type Tx } from '@blockly/db'
import { isAddedJar } from '../../minecraft/uploads.ts'
import { DOWNLOAD_NOTE, downloadNote, inWorldDownload } from '../../minecraft/world-download.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { FileFormats } from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { ArchiveTarget, PartsUpload, PutPart } from '../ports/runtime.ts'
import { findServer } from '../servers/persistence.ts'
import {
  type DownloadRecord,
  insertDownload,
  liveDownload,
  loadDownload,
  newestDownload,
  setDownload,
} from './download-records.ts'
import { type BackupRecord, loadBackup } from './persistence.ts'

/** Where a download stands, as the backups page shows it. */
export type DownloadState =
  | { status: 'ready'; url: string }
  | { status: 'making' }
  | { status: 'failed'; message: string }

/** A copy is kept a day: long enough to download, short enough to cost little. */
const KEPT_MS = 24 * 60 * 60 * 1000
/** A download link is used at once; the store checks it when the download starts, not after. */
const DOWNLOAD_LINK_SECONDS = 10 * 60
/** Reading the archive and writing the copy take as long as a few gigabytes take. */
const MAKING_LINK_SECONDS = 2 * 60 * 60
/** How long an ask waits for its copy before saying it's being made: a small world is ready by then. */
const QUICK_MS = 5_000
const QUICK_POLL_MS = 250

const FAILED = 'Cubepals couldn’t make this download. Try again.'

export class WorldDownloads {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #formats: FileFormats
  readonly #jobs: JobQueue

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    capabilities: DeploymentCapabilities
    formats: FileFormats
    jobs: JobQueue
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#formats = deps.formats
    this.#jobs = deps.jobs
  }

  /**
   * The owner asks to download an archive: its copy's link when one is ready, else a copy is
   * made, once however often it is asked for, and waited on for a moment.
   */
  async ask(actor: Actor, serverId: string, backupId: string): Promise<DownloadState> {
    const asked = await this.#db.transaction(async (tx) => {
      const { server, archive } = await this.#downloadable(tx, actor, serverId, backupId)
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'server.archive_downloaded',
        subjectType: 'server',
        subjectId: server.id,
        data: { backupId },
      })
      return { server, archive, download: await this.#copyOf(tx, server.id, archive) }
    })
    let download = asked.download
    const until = Date.now() + QUICK_MS
    while (download.status === 'pending' && Date.now() < until) {
      await sleep(QUICK_POLL_MS)
      download = (await loadDownload(this.#db, download.id)) ?? download
    }
    return this.#state(asked.server.slug, asked.archive, download)
  }

  /** Where the newest download asked of an archive stands, for the page waiting on it. */
  async state(actor: Actor, serverId: string, backupId: string): Promise<DownloadState> {
    const { server, archive } = await this.#db.transaction((tx) =>
      this.#downloadable(tx, actor, serverId, backupId),
    )
    const download = await newestDownload(this.#db, archive.id)
    if (download === null) throw new NotFound('Download')
    return this.#state(server.slug, archive, download)
  }

  /**
   * `world-download`: the archive read from the store and written back as the copy, as it
   * streams, never held whole on the worker.
   */
  async make(downloadId: string): Promise<void> {
    const download = await loadDownload(this.#db, downloadId)
    if (download === null || download.status !== 'pending') return
    const archive = await loadBackup(this.#db, download.backupId)
    if (archive === null || archive.archiveKey === null) {
      await setDownload(this.#db, downloadId, { status: 'failed', error: FAILED })
      return
    }
    const store = requireCapability(this.#caps, 'archives')
    const source = await store.presignGet(archive.archiveKey, MAKING_LINK_SECONDS, 'browser')
    const leftOut: string[] = []
    const body = await this.#formats.filterTarball(source.url, {
      kept: (path) => {
        if (inWorldDownload(path)) return true
        if (isAddedJar(path)) leftOut.push(path)
        return false
      },
      added: () => new Map([[DOWNLOAD_NOTE, downloadNote(leftOut)]]),
    })
    const most = archive.sizeBytes ?? (await store.head(archive.archiveKey))?.sizeBytes ?? 0
    const target = await store.archiveTarget(download.key, MAKING_LINK_SECONDS, 'browser')
    const sizeBytes = await putStream(body, target, most)
    // Erased while it was being made (its archive went, or its day passed): the copy goes too.
    if ((await loadDownload(this.#db, downloadId))?.status !== 'pending') {
      await store.delete(download.key)
      return
    }
    await setDownload(this.#db, downloadId, {
      status: 'ready',
      sizeBytes,
      expiresAt: new Date(Date.now() + KEPT_MS),
    })
  }

  /** The last attempt failed: its owner reads that it didn't work, and can ask again. */
  async gaveUp(downloadId: string, error: string): Promise<void> {
    console.error(`world-download ${downloadId}: ${error}`)
    await setDownload(this.#db, downloadId, { status: 'failed', error: FAILED })
  }

  /** The server and the archive a download is of, where the actor may download it. */
  async #downloadable(tx: Tx, actor: Actor, serverId: string, backupId: string) {
    const server = authorize(actor, await findServer(tx, serverId))
    await this.#policy.require(tx, server.ownerId, { kind: 'download_archive' })
    const archive = await loadBackup(tx, backupId)
    if (archive === null || archive.serverId !== server.id || archive.tier !== 'archive')
      throw new NotFound('Backup')
    if (archive.status !== 'ready' || archive.archiveKey === null) throw new NotFound('Backup')
    requireCapability(this.#caps, 'archives')
    return { server, archive }
  }

  /**
   * The archive's copy being made or ready, or a new one asked of a worker. One ready but too
   * near its end to outlast a link is let go, for the sweep, and made again.
   */
  async #copyOf(tx: Tx, serverId: string, archive: BackupRecord): Promise<DownloadRecord> {
    const live = await liveDownload(tx, archive.id)
    if (live !== null && live.expiresAt.getTime() > Date.now() + DOWNLOAD_LINK_SECONDS * 1000) return live
    if (live !== null) await setDownload(tx, live.id, { status: 'expired' })
    const id = randomUUID()
    const store = requireCapability(this.#caps, 'archives')
    const made = await insertDownload(tx, {
      id,
      backupId: archive.id,
      key: store.newKey('world_download', { serverId, id }),
      // Until it is made; a copy never made is swept a day on.
      expiresAt: new Date(Date.now() + KEPT_MS),
    })
    if (made === null) {
      // Asked at the same moment by another request, which made it.
      const other = await liveDownload(tx, archive.id)
      if (other === null) throw new Error(`No download of ${archive.id} is being made`)
      return other
    }
    await this.#jobs.enqueueWorldDownload(tx, id)
    return made
  }

  async #state(slug: string, archive: BackupRecord, download: DownloadRecord): Promise<DownloadState> {
    if (download.status === 'pending') return { status: 'making' }
    if (download.status !== 'ready') return { status: 'failed', message: download.error ?? FAILED }
    const name = `${slug}-${archive.createdAt.toISOString().slice(0, 16).replace(/[T:]/g, '-')}.tar.gz`
    const store = requireCapability(this.#caps, 'archives')
    const link = await store.presignGet(download.key, DOWNLOAD_LINK_SECONDS, 'browser', name)
    return { status: 'ready', url: link.url }
  }
}

/** A copy this small goes to the store in one PUT; a larger one in parts, as it arrives. */
const ONE_PUT_BYTES = 8 * 1024 ** 2

/**
 * Writes a stream of a length nobody knows ahead to `target`, holding at most a part of it at a
 * time: in one PUT when it is small, else part by part. `most` is how large it can be, which the
 * store plans the parts by. Returns its size.
 */
async function putStream(
  body: ReadableStream<Uint8Array>,
  target: ArchiveTarget,
  most: number,
): Promise<number> {
  let upload: PartsUpload | null = null
  const parts: PutPart[] = []
  let held: Uint8Array[] = []
  let heldBytes = 0
  let size = 0
  const put = async (url: string, headers: Record<string, string>, bytes: Buffer) => {
    const answer = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes), headers })
    if (!answer.ok) throw new Error(`The store answered ${answer.status} to the copy`)
    return answer.headers.get('etag') ?? ''
  }
  const send = async (partsUpload: PartsUpload, bytes: Buffer) => {
    const url = partsUpload.urls[parts.length]
    if (url === undefined) throw new Error(`The copy is larger than the ${most} bytes planned for`)
    parts.push({ number: parts.length + 1, etag: await put(url, partsUpload.headers, bytes) })
  }
  try {
    for await (const chunk of body) {
      held.push(chunk)
      heldBytes += chunk.byteLength
      size += chunk.byteLength
      if (upload === null && heldBytes > ONE_PUT_BYTES) upload = await target.inParts(Math.max(most, size))
      if (upload === null || heldBytes < upload.partSize) continue
      let all = Buffer.concat(held)
      while (all.length >= upload.partSize) {
        await send(upload, all.subarray(0, upload.partSize))
        all = all.subarray(upload.partSize)
      }
      held = [all]
      heldBytes = all.length
    }
    const rest = Buffer.concat(held)
    if (upload === null) {
      await put(target.put.url, target.put.headers, rest)
      return size
    }
    if (rest.length > 0) await send(upload, rest)
    await upload.complete(parts)
    return size
  } catch (error) {
    await upload?.abort()
    throw error
  }
}
