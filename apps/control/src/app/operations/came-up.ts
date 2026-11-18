// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a boot does once it lets its players in: the operation's own word that the server runs,
 * where it gives one (`ready`), and after it what the boot reads of itself: the mods its run said
 * it didn't load, kept for its owner, and the files its owner asked back, settled (`cameUp`,
 * `control-plane.ts`). That reading takes seconds, the run's log read whole among it, and a player
 * held while the server woke is handed over only once it runs: so it comes after, and nobody
 * waiting to join waits on it. Once the server runs, a failure in it is logged, not the start's:
 * the server came up, and the next boot reads it all again.
 *
 * Not for what decides whether a server is up, which is `boot.ts`'s, before players are let in.
 */

import type { ServerRevision } from '../../domain/revision/revision.ts'
import { lastRun, notLoaded, saysNotLoaded } from '../../minecraft/logs.ts'
import { inFull } from '../errors.ts'
import type { LogSource } from '../ports/platform.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'

/** Enough of the tail to hold a Paper server's whole start, plugins' stack traces and all. */
const RUN_LINES_READ = 2_000

/** What reading a boot that came up needs. */
export interface CameUpDeps {
  logs: Pick<LogSource, 'recent'>
  cameUp: (serverId: string, names: string[], handle: RuntimeHandle) => Promise<void>
}

/**
 * After a boot let its players in: `ready`, then what it read of its run. `leftOut` is what the
 * boot's own output said it left out, as `boot.ts` keeps it.
 */
export async function afterLetIn(
  deps: CameUpDeps,
  serverId: string,
  handle: RuntimeHandle,
  mods: ServerRevision['mods'],
  leftOut: readonly string[],
  ready?: () => Promise<void>,
): Promise<void> {
  // Up, yet without all it was told to load: Paper goes on past a plugin it can't load, and the
  // server says so rather than passing for one that runs everything. A log followed from the boot
  // may have begun after a line printed early, so this run's own log is read too.
  const read = async () => {
    const recent = await deps.logs.recent(handle, RUN_LINES_READ).catch(() => [])
    const said = [...leftOut, ...lastRun(recent.map((line) => line.text)).filter(saysNotLoaded)]
    await deps.cameUp(serverId, notLoaded(said, mods), handle)
  }
  if (ready === undefined) return read()
  await ready()
  await read().catch((error: unknown) => {
    console.warn(`server ${serverId}: what its start left out wasn't read (${inFull(error)})`)
  })
}
