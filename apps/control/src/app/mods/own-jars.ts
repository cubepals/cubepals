// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A jar its owner brought inside another upload (a world's mods folder, docs/world-import.md §
 * Mods), kept as their own upload of it is (`ModService.finishUpload`): refused where their plan
 * doesn't take uploaded mods, where it matches known malware or its classes do (`JarChecks.check`,
 * read here and now, so it can go on a server at once), or where it isn't a mod a server runs
 * (`readUploadedJar`); else stored under its bytes and recorded as their upload. Not where a jar is
 * matched to the catalog (`jar-matches.ts`) or added to a server.
 */
import { readFile } from 'node:fs/promises'
import type { Db } from '@blockly/db'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { FileFormats } from '../ports/formats.ts'
import { refusalOf } from './jar-check-records.ts'
import type { JarChecks } from './jar-checks.ts'
import { readUploadedJar } from './jar-uploads.ts'
import { keptAsUpload } from './uploads.ts'

/** A jar kept as its owner's upload, or the sentence on why it wasn't. */
export type OwnJar = { uploadId: string } | { refused: string }

export class OwnJars {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #checks: Pick<JarChecks, 'check'>
  readonly #formats: FileFormats
  readonly #catalog: ModCatalog
  readonly #caps: DeploymentCapabilities

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    jarChecks: Pick<JarChecks, 'check'>
    formats: FileFormats
    catalog: ModCatalog
    capabilities: DeploymentCapabilities
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#checks = deps.jarChecks
    this.#formats = deps.formats
    this.#catalog = deps.catalog
    this.#caps = deps.capabilities
  }

  /** Whether `ownerId`'s plan takes their own jars, or the sentence on why not. */
  async mayKeep(ownerId: string): Promise<string | null> {
    const decision = await this.#db.transaction((tx) =>
      this.#policy.check(tx, ownerId, { kind: 'upload_mod' }),
    )
    return decision.ok ? null : decision.message
  }

  /** The jar at `path` on this machine, as `fileName`, kept as `ownerId`'s upload, or why it wasn't. */
  async keep(ownerId: string, jar: { path: string; fileName: string }): Promise<OwnJar> {
    const bytes = new Uint8Array(await readFile(jar.path))
    const check = await this.#checks.check(bytes)
    const refusal = refusalOf(jar.fileName, check)
    if (refusal !== null) return { refused: refusal }
    let metadata: Awaited<ReturnType<typeof readUploadedJar>>
    try {
      metadata = await readUploadedJar(
        { formats: this.#formats, catalog: this.#catalog },
        bytes,
        check.sha512,
      )
    } catch (error) {
      if (error instanceof AppError) return { refused: error.message }
      throw error
    }
    const key = await requireCapability(this.#caps, 'archives').ingestFile(jar.path, check.sha512)
    const uploadId = await this.#db.transaction((tx) =>
      keptAsUpload(tx, {
        ownerId,
        sha512: check.sha512,
        key,
        sizeBytes: bytes.length,
        fileName: jar.fileName,
        metadata,
      }),
    )
    return { uploadId }
  }
}
