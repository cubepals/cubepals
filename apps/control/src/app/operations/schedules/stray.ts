// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finds compute the provider says is running that no running server here accounts for: a server
 * the control plane thinks is stopped, one it doesn't know, or one bound to other compute. Such a
 * machine is billed, and nothing would ever stop it for being idle. The spend watchdog counts and
 * prices what this finds (`spend.ts`); the orphan sweep stops it (`orphans.ts`).
 * Deciding what to do about compute nobody owns, beyond stopping it, stays `orphans.ts`'s.
 */
import type { Db } from '@blockly/db'
import type { ServerStatus } from '../../../domain/server/lifecycle.ts'
import type { RuntimeHandle, RuntimeKey } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { findServer, loadRuntime } from '../../servers/persistence.ts'
import { activeOperation } from '../persistence.ts'
import { SERVER_ID } from './reconcile.ts'

/** Statuses whose server may hold running compute: on its way up, up, or on its way down. */
const MAY_RUN: ReadonlySet<ServerStatus> = new Set([
  'provisioning',
  'starting',
  'running',
  'stopping',
  'updating',
  'restoring',
  'relocating',
])

export interface StrayCompute {
  key: RuntimeKey
  handle: RuntimeHandle
  /** The server it is for, when the database knows it, and that server's status and size. */
  serverId: string | null
  status: ServerStatus | null
  tier: string | null
  /** When the provider last saw it change: running since then, as far as anyone here knows. */
  since: Date
}

/**
 * Running compute no running server accounts for, from one full listing. Compute with work in
 * flight on its server is left out: a start, a move or a restore holds compute before the status
 * says so. A read that fails throws, so nothing is called stray on a guess.
 */
export async function strayCompute(
  db: Db,
  runtime: Pick<Runtimes, 'observeChanged' | 'providers' | 'sameCompute'>,
): Promise<StrayCompute[]> {
  const found: StrayCompute[] = []
  for await (const { key, handle, observation } of runtime.observeChanged(new Date(0))) {
    if (observation.state !== 'running' && observation.state !== 'starting') continue
    const server = SERVER_ID.test(key) ? await findServer(db, key) : null
    const stray = { key, handle, since: observation.at }
    if (server === null) {
      found.push({ ...stray, serverId: null, status: null, tier: null })
      continue
    }
    if ((await activeOperation(db, server.id)) !== null) continue
    const binding = await loadRuntime(db, server.id, runtime.providers)
    const bound = binding.handle !== null && runtime.sameCompute(binding.handle, handle)
    if (bound && MAY_RUN.has(server.lifecycle.status)) continue
    found.push({ ...stray, serverId: server.id, status: server.lifecycle.status, tier: server.memoryTier })
  }
  return found
}
