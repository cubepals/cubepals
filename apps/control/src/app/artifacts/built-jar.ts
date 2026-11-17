// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A plugin or mod Cubepals builds from this repository and places on servers itself: the join
 * reporter (`reporter.ts`) and Offline world progression's plugin and mod (`progression-jar.ts`). The control plane's
 * image carries each jar; as the control plane starts, each is kept in the archive store under its
 * SHA-512, as a jar Blockly built, and handed to servers over their artifact links like any other.
 * No revision pins one, so garbage collection leaves them alone (`service.ts`).
 *
 * Not for anything a start depends on: without the jar, or an archive store, no server gets it.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { Queryable } from '@blockly/db'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ArchiveStore } from '../ports/optional.ts'
import { recordStored, storedArtifact } from './persistence.ts'

/** What a built jar is: where the image puts it, and how a server's plugins name it. */
interface Described {
  /** Where the image puts the jar (apps/control/Dockerfile). */
  inImage: string
  fileName: string
  /** Its id among Cubepals' own projects (`catalog: 'cubepals'`). */
  projectId: string
  /** Its name, as its `plugin.yml` or `fabric.mod.json` gives it. */
  name: string
  /** Where a server keeps it, under its directory: `plugins` on Paper, `mods` on Fabric. */
  dir: 'plugins' | 'mods'
  loaders: readonly string[]
  /** What the log calls it when it can't be stored. */
  said: string
}

export class BuiltJar {
  readonly #described: Described
  #path: string
  #read: Promise<{ sha512: string; sizeBytes: number } | null> | null = null

  constructor(described: Described) {
    this.#described = described
    this.#path = described.inImage
  }

  /** Reads the jar from elsewhere: a test's own, or none (a path that doesn't exist). */
  use(path: string = this.#described.inImage): void {
    this.#path = path
    this.#read = null
  }

  /** The jar's identity, read once; null where there is no jar, as in development. */
  identity(): Promise<{ sha512: string; sizeBytes: number } | null> {
    this.#read ??= readFile(this.#path).then(
      (bytes) => ({ sha512: createHash('sha512').update(bytes).digest('hex'), sizeBytes: bytes.length }),
      () => null,
    )
    return this.#read
  }

  /** Keeps the jar in the archive store, unless it is there already. */
  async #store(q: Queryable, store: ArchiveStore | null): Promise<void> {
    const jar = await this.identity()
    if (jar === null || store === null || (await storedArtifact(q, jar.sha512)) !== null) return
    const key = await store.ingestFile(this.#path, jar.sha512)
    await recordStored(q, { ...jar, key, source: 'built' })
  }

  /**
   * Stores the jar, and where that fails (the archive store down as the control plane starts),
   * tries again later, each wait twice the last up to an hour, until it is stored: until then no
   * server gets it.
   */
  keepStored(q: Queryable, store: ArchiveStore | null, wait = MINUTE_MS): void {
    this.#store(q, store).catch((error: unknown) => {
      console.error(
        `artifacts: ${this.#described.said} could not be stored; trying again in ${wait / SECOND_MS}s`,
        error,
      )
      setTimeout(() => this.keepStored(q, store, Math.min(wait * 2, HOUR_MS)), wait).unref()
    })
  }

  /** The jar as a server's plugins pin it, once it is stored; null before then, or with no jar. */
  async pin(q: Queryable): Promise<PinnedMod | null> {
    const jar = await this.identity()
    const stored = jar === null ? null : await storedArtifact(q, jar.sha512)
    if (jar === null || stored === null) return null
    const { fileName, projectId, name, dir, loaders } = this.#described
    return {
      source: { catalog: 'cubepals', projectId, versionId: jar.sha512.slice(0, 12) },
      name,
      versionLabel: jar.sha512.slice(0, 12),
      artifact: { ref: { kind: 'stored', key: stored.key }, ...jar, fileName },
      environment: 'server',
      loaders: [...loaders],
      gameVersions: [],
      origin: 'dependency',
      requiredBy: [],
      dir,
    }
  }
}
