// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The join reporter, the Paper plugin Cubepals places beside a server's own plugins so the server
 * tells its half of each join (apps/reporter), built from this repository and kept as a built jar
 * (`built-jar.ts`). Which servers get it is `JOIN_REPORTER`'s (`servers/specs.ts`).
 */
import { fileURLToPath } from 'node:url'
import type { Queryable } from '@blockly/db'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ArchiveStore } from '../ports/optional.ts'
import { BuiltJar } from './built-jar.ts'

const REPORTER = new BuiltJar({
  inImage: fileURLToPath(new URL('../../../assets/reporter/cubepals-reporter.jar', import.meta.url)),
  fileName: 'cubepals-reporter.jar',
  projectId: 'reporter',
  name: 'Cubepals',
  dir: 'plugins',
  loaders: ['paper'],
  said: 'the join reporter',
})

/** Reads the jar from elsewhere: a test's own, or none (a path that doesn't exist). */
export const useReporterJar = (path?: string): void => REPORTER.use(path)

/** The jar's identity, read once; null where there is no jar, as in development. */
export const reporterJar = () => REPORTER.identity()

/** Stores the jar, trying again later where the store fails (`BuiltJar.keepStored`). */
export const keepReporterStored = (q: Queryable, store: ArchiveStore | null, wait?: number): void =>
  REPORTER.keepStored(q, store, wait)

/** The reporter as a server's plugins pin it, once it is stored; null before then, or with no jar. */
export const reporterPin = (q: Queryable): Promise<PinnedMod | null> => REPORTER.pin(q)
