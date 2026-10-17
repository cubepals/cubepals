// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { timingSafeEqual } from 'node:crypto'
import { DAY_MS, MINUTE_MS, MINUTE_S } from '@blockly/contracts/durations'
import type { Db, Tx } from '@blockly/db'
import type { ModArtifact, PinnedMod } from '../../domain/mods/artifact.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { diskName } from '../../minecraft/jars.ts'
import { starterOf, startersBySha512 } from '../../minecraft/starter.ts'
import { revokedIn } from '../catalog/persistence.ts'
import { quarantinedOf } from '../mods/jar-check-records.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { Locks } from '../ports/locks.ts'
import type { ArchiveStore } from '../ports/optional.ts'
import { acceptedSecrets, type SecretKeyring } from '../secrets.ts'
import { loadOwnIcon } from '../server-icons/persistence.ts'
import { claimPendingUpload, uploadsToClear } from '../uploads/persistence.ts'
import {
  compatPinned,
  firstWorldOfType,
  forgetStored,
  markArtifactsRefreshed,
  pinnedBy,
  recordStored,
  storedArtifact,
  unreferencedStored,
} from './persistence.ts'

export type UnavailableReason = 'no_archive_store' | 'not_stored' | 'revoked'

/** A jar a revision needs that Blockly can't hand to the server, found before the runtime is touched. */
export class ArtifactUnavailable extends Error {
  readonly sha512: string
  readonly reason: UnavailableReason

  constructor(mod: { name: string; artifact: ModArtifact }, reason: UnavailableReason) {
    super(`${mod.name} ${WHY[reason]}`)
    this.name = 'ArtifactUnavailable'
    this.sha512 = mod.artifact.sha512
    this.reason = reason
  }
}

const WHY: Record<UnavailableReason, string> = {
  no_archive_store: 'is an upload, and this deployment keeps no uploads.',
  not_stored: 'is an upload that is no longer stored.',
  revoked: 'was taken down where it was published.',
}

/** A request for a jar with the wrong token: not this server's runtime asking. */
export class ArtifactForbidden extends Error {}

/** No revision of this server pins these bytes. */
export class ArtifactNotFound extends Error {}

export interface LocatedArtifact {
  /** The bytes themselves: a mod's jar, or the pack file a revision plays. */
  artifact: ModArtifact
  /** The mod that pins them, where one does; a modpack is pinned by the revision itself. */
  pinned: PinnedMod | null
  /** The file's name on disk and the last segment of its link. */
  name: string
  /**
   * When the bytes were pinned, or when the installed copies were last found wrong, whichever
   * is later. The image downloads again only when this is newer than its file.
   */
  lastModified: Date
}

/** A presigned link stays valid for one download. */
const DOWNLOAD_LINK_SECONDS = 10 * MINUTE_S

/**
 * A jar being copied elsewhere is waited for this long by the mirror queue; mirroring is never
 * urgent. A boot doesn't wait at all: the wait holds a database connection, and a rush of servers
 * of one pack would hold them all while one copy runs. Its server fetches the published file.
 */
const MIRROR_WAIT_MS = 2 * MINUTE_MS

/** How long a stored blob may go unused before `artifact-gc` deletes it. */
const GC_GRACE_MS = 7 * DAY_MS
/** An upload nobody finished in a day is abandoned. */
const ABANDONED_UPLOAD_MS = DAY_MS

/**
 * Where a revision's jar bytes come from, and who may fetch them (§15.2): checked before a boot,
 * handed to game runtimes through stable links, mirrored when the deployment keeps copies.
 */
export class ArtifactService {
  readonly #db: Db
  readonly #archive: ArchiveStore | null
  readonly #secrets: SecretKeyring
  readonly #mirror: boolean
  readonly #jobs: JobQueue
  readonly #locks: Locks

  constructor(deps: {
    db: Db
    archive: ArchiveStore | null
    secrets: SecretKeyring
    /** Keep a copy of every catalog jar a revision pins (`artifacts.mirrorCatalogArtifacts`). */
    mirror: boolean
    jobs: JobQueue
    locks: Locks
  }) {
    this.#db = deps.db
    this.#archive = deps.archive
    this.#secrets = deps.secrets
    this.#mirror = deps.mirror
    this.#jobs = deps.jobs
    this.#locks = deps.locks
  }

  /**
   * A revision now pins these jars. Where the deployment keeps copies, each catalog jar it
   * doesn't hold yet is queued for `artifact-mirror`, in the transaction that pins it (§9).
   */
  async pinned(tx: Tx, mods: readonly PinnedMod[], modpack?: PinnedModpack | null): Promise<void> {
    if (!this.#mirror || this.#archive === null) return
    // A pack is one more file a revision pins, and it is fetched over the same link as the jars.
    const artifacts = [...mods.map((mod) => mod.artifact), ...(modpack ? [modpack.artifact] : [])]
    for (const artifact of artifacts)
      if (artifact.ref.kind === 'remote' && (await storedArtifact(tx, artifact.sha512)) === null)
        await this.#jobs.enqueueMirror(tx, artifact)
  }

  /**
   * `artifact-gc` (§9), daily: uploads nobody finished and staging copies leave the store, then
   * blobs no revision of a live server pins, once they have gone unused for the grace period.
   * Nothing to do on a deployment without archives.
   */
  async collectGarbage(now = new Date()): Promise<{ uploads: number; blobs: number }> {
    const store = this.#archive
    if (store === null) return { uploads: 0, blobs: 0 }
    let uploads = 0
    for (const upload of await uploadsToClear(this.#db, new Date(now.getTime() - ABANDONED_UPLOAD_MS))) {
      // Taken before its file goes: a finish that took it first keeps the file as its backup's, and
      // a file that can't be deleted now leaves the upload for the next run.
      const cleared = await this.#db.transaction(async (tx) => {
        if (!(await claimPendingUpload(tx, upload.id))) return false
        await store.delete(upload.key)
        return true
      })
      if (cleared) uploads++
    }
    let blobs = 0
    for (const blob of await unreferencedStored(this.#db, new Date(now.getTime() - GC_GRACE_MS))) {
      if (!(await this.#db.transaction((tx) => forgetStored(tx, blob.sha512)))) continue
      await store.delete(blob.key)
      blobs++
    }
    return { uploads, blobs }
  }

  /**
   * Whether every jar of a revision can be handed to its server, before a boot depends on it:
   * uploads must be in the store, catalog jars must not be taken down. Mirrors what isn't
   * mirrored yet, when the deployment mirrors; a failed copy leaves the published file to serve.
   */
  async preflight(
    revision: Pick<ServerRevision, 'mods' | 'acknowledgedRevoked'> & Partial<Pick<ServerRevision, 'modpack'>>,
  ): Promise<void> {
    const revoked = await revokedIn(this.#db, revision.mods)
    // Taken down upstream: the owner may have chosen to run it anyway, and said so (§15.3).
    const refused = revoked.find((mod) => !revision.acknowledgedRevoked.includes(mod.artifact.sha512))
    if (refused !== undefined) throw new ArtifactUnavailable(refused, 'revoked')
    for (const mod of revision.mods) {
      const { ref } = mod.artifact
      if (ref.kind === 'stored') {
        if (this.#archive === null) throw new ArtifactUnavailable(mod, 'no_archive_store')
        if ((await this.#archive.head(ref.key)) === null) throw new ArtifactUnavailable(mod, 'not_stored')
      } else if (this.#mirror) await this.mirror(mod.artifact, 0).catch(() => undefined)
    }
    // A pack is one more file the server fetches: one built from an upload must be in the store.
    const pack = revision.modpack ?? null
    if (pack !== null) {
      const { ref } = pack.artifact
      const asMod = { name: pack.name, artifact: pack.artifact }
      if (ref.kind === 'stored') {
        if (this.#archive === null) throw new ArtifactUnavailable(asMod, 'no_archive_store')
        if ((await this.#archive.head(ref.key)) === null) throw new ArtifactUnavailable(asMod, 'not_stored')
      } else if (this.#mirror) await this.mirror(pack.artifact, 0).catch(() => undefined)
    }
  }

  /**
   * Copies a catalog jar into the store, verified, unless a copy is already kept. The queue and a
   * boot's preflight can ask at once; they take turns per jar, so it is fetched once. One that
   * finds it being copied waits `waitMs` for that copy, then gives up with `LockBusy`.
   */
  async mirror(artifact: ModArtifact, waitMs = MIRROR_WAIT_MS): Promise<void> {
    const store = this.#archive
    const { ref } = artifact
    if (store === null || ref.kind !== 'remote') return
    await this.#locks.hold(`mirror:${artifact.sha512}`, waitMs, async () => {
      if ((await storedArtifact(this.#db, artifact.sha512)) !== null) return
      const key = await store.ingestFromUrl(ref.url, artifact.sha512)
      await recordStored(this.#db, {
        sha512: artifact.sha512,
        key,
        sizeBytes: artifact.sizeBytes,
        source: 'mirror',
      })
    })
  }

  /**
   * A game runtime asking for one of its server's jars. Only the server's own token, and only
   * bytes one of its revisions pins; everything a HEAD needs comes from the database.
   */
  async locate(serverId: string, sha512: string, token: string): Promise<LocatedArtifact> {
    this.#authorize(serverId, token)
    // Malware is handed to no server, whatever pins it (`mods/jar-checks.ts`).
    if ((await quarantinedOf(this.#db, [sha512])).size > 0) throw new ArtifactNotFound()
    const found = await pinnedBy(this.#db, serverId, sha512)
    if (found === null) return this.#compat(serverId, sha512)
    const pinned = found
    // An HTTP date holds whole seconds: a refresh rounds up, so it is newer than every file that
    // was on disk when the jars were found wrong, even one written the same second.
    const refreshed =
      pinned.refreshedAt === null ? null : new Date(Math.ceil(pinned.refreshedAt.getTime() / 1000) * 1000)
    const lastModified = refreshed !== null && refreshed > pinned.pinnedAt ? refreshed : pinned.pinnedAt
    return {
      artifact: pinned.artifact,
      pinned: pinned.mod,
      name: diskName(pinned.artifact),
      lastModified,
    }
  }

  /** A Via plugin of Cubepals' compatibility layer, or else the archive a world starts on. */
  async #compat(serverId: string, sha512: string): Promise<LocatedArtifact> {
    const via = await compatPinned(this.#db, sha512)
    if (via === null) return this.#starter(serverId, sha512)
    return {
      artifact: via.mod.artifact,
      pinned: via.mod,
      name: diskName(via.mod.artifact),
      lastModified: via.pinnedAt,
    }
  }

  /** The archive a world of the server's starts on (`minecraft/starter.ts`), as of that world. */
  async #starter(serverId: string, sha512: string): Promise<LocatedArtifact> {
    const levelTypes = startersBySha512(sha512)
    const artifact = levelTypes.length === 0 ? null : starterOf(levelTypes[0] ?? '')
    const since = await firstWorldOfType(this.#db, serverId, levelTypes)
    if (artifact === null || since === null) throw new ArtifactNotFound()
    return { artifact, pinned: null, name: diskName(artifact), lastModified: since }
  }

  /**
   * A game runtime asking for the picture its owner gave it, at a start. It is theirs alone, so it
   * takes the server's own token too, and is looked for under that server only.
   */
  async ownIcon(serverId: string, sha256: string, token: string): Promise<Buffer | null> {
    this.#authorize(serverId, token)
    return loadOwnIcon(this.#db, serverId, sha256)
  }

  #authorize(serverId: string, token: string): void {
    // During a rotation a server not yet moved onto the new key still asks with its old token.
    const given = Buffer.from(token)
    const accepted = acceptedSecrets(this.#secrets, serverId, 'artifacts').map((secret) =>
      Buffer.from(secret),
    )
    if (!accepted.some((expected) => given.length === expected.length && timingSafeEqual(given, expected)))
      throw new ArtifactForbidden()
  }

  /** Where the bytes are fetched: the store's copy when there is one, else where they were published. */
  async source(located: LocatedArtifact): Promise<string> {
    const { ref, sha512 } = located.artifact
    const key = ref.kind === 'stored' ? ref.key : (await storedArtifact(this.#db, sha512))?.key
    if (key !== undefined && this.#archive !== null)
      return (await this.#archive.presignGet(key, DOWNLOAD_LINK_SECONDS, 'runtime', located.name)).url
    if (ref.kind === 'remote') return ref.url
    throw new ArtifactUnavailable(
      located.pinned ?? { name: located.name, artifact: located.artifact },
      this.#archive === null ? 'no_archive_store' : 'not_stored',
    )
  }

  /**
   * The installed jars were found wrong: from now on their links report a newer Last-Modified,
   * so the image downloads every one of them again on the server's next boot.
   */
  async refresh(serverId: string, at = new Date()): Promise<void> {
    await markArtifactsRefreshed(this.#db, serverId, at)
  }
}
