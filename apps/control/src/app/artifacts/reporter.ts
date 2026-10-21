// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The join reporter, the Paper plugin Cubepals places beside a server's own plugins so the server
 * tells its half of each join (apps/reporter). The control plane's image carries the jar, built
 * from this repository; as the control plane starts, it is kept in the archive store under its
 * SHA-512, as a jar Blockly built, and handed to servers over their artifact links like any other.
 * Which servers get it is `JOIN_REPORTER`'s (`servers/specs.ts`).
 *
 * Not for anything a start depends on: without the jar, or an archive store, no server gets it.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { Queryable } from '@blockly/db'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ArchiveStore } from '../ports/optional.ts'
import { recordStored, storedArtifact } from './persistence.ts'

/** Where the image puts the jar (apps/control/Dockerfile). */
const IN_IMAGE = fileURLToPath(new URL('../../../assets/reporter/cubepals-reporter.jar', import.meta.url))
const FILE_NAME = 'cubepals-reporter.jar'

let jarPath = IN_IMAGE
let read: Promise<{ sha512: string; sizeBytes: number } | null> | null = null

/** Reads the jar from elsewhere: a test's own, or none (a path that doesn't exist). */
export function useReporterJar(path: string = IN_IMAGE): void {
  jarPath = path
  read = null
}

/** The jar's identity, read once; null where there is no jar, as in development. */
export function reporterJar(): Promise<{ sha512: string; sizeBytes: number } | null> {
  read ??= readFile(jarPath).then(
    (bytes) => ({ sha512: createHash('sha512').update(bytes).digest('hex'), sizeBytes: bytes.length }),
    () => null,
  )
  return read
}

/** Keeps the jar in the archive store, unless it is there already. */
async function storeReporter(q: Queryable, store: ArchiveStore | null): Promise<void> {
  const jar = await reporterJar()
  if (jar === null || store === null || (await storedArtifact(q, jar.sha512)) !== null) return
  const key = await store.ingestFile(jarPath, jar.sha512)
  await recordStored(q, { ...jar, key, source: 'built' })
}

/**
 * Stores the jar, and where that fails (the archive store down as the control plane starts), tries
 * again later, each wait twice the last up to an hour, until it is stored: until then no server
 * gets the reporter.
 */
export function keepReporterStored(q: Queryable, store: ArchiveStore | null, wait = MINUTE_MS): void {
  storeReporter(q, store).catch((error: unknown) => {
    console.error(
      `artifacts: the join reporter could not be stored; trying again in ${wait / SECOND_MS}s`,
      error,
    )
    setTimeout(() => keepReporterStored(q, store, Math.min(wait * 2, HOUR_MS)), wait).unref()
  })
}

/** The reporter as a server's plugins pin it, once it is stored; null before then, or with no jar. */
export async function reporterPin(q: Queryable): Promise<PinnedMod | null> {
  const jar = await reporterJar()
  const stored = jar === null ? null : await storedArtifact(q, jar.sha512)
  if (jar === null || stored === null) return null
  return {
    source: { catalog: 'cubepals', projectId: 'reporter', versionId: jar.sha512.slice(0, 12) },
    name: 'Cubepals',
    versionLabel: jar.sha512.slice(0, 12),
    artifact: { ref: { kind: 'stored', key: stored.key }, ...jar, fileName: FILE_NAME },
    environment: 'server',
    loaders: ['paper'],
    gameVersions: [],
    origin: 'dependency',
    requiredBy: [],
    dir: 'plugins',
  }
}
