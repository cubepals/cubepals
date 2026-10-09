/**
 * Brings what is recorded of each server in line with what its provider lists, from where the last
 * settled pass began: a crash is recorded, compute behind a server that holds none is stopped, and
 * compute that came back at another address is readdressed. Moving a server off a lost host is
 * `relocations.ts`'s; compute no server owns is `orphans.ts`'s.
 */
import { type Db, schema } from '@blockly/db'
import type { ServerStatus } from '../../../domain/server/lifecycle.ts'
import type { ObservedState, RuntimeHandle, RuntimeObservation } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import {
  findServer,
  HOST_LOST,
  loadRuntime,
  lockServer,
  saveHandle,
  saveObserved,
} from '../../servers/persistence.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { clearPresence, closeInterval, openIntervalStart } from '../../servers/usage.ts'
import { activeOperation } from '../persistence.ts'
import { observedJson, recordHostLost } from './observations.ts'

export const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** How often reconcile reads all compute rather than what changed (§9). */
const FULL_PASS_MS = 60 * 60_000
/** Observed states of a workload that isn't running. */
const EXITED: ReadonlySet<ObservedState> = new Set(['stopped', 'crashed', 'absent'])
/** Server statuses that hold no compute: anything running behind one is stray. */
const HOLDS_NONE: ReadonlySet<ServerStatus> = new Set(['stopped', 'failed', 'storing', 'stored'])

export function reconciling(deps: {
  db: Db
  runtime: Pick<
    Runtimes,
    'observeChanged' | 'providers' | 'sameCompute' | 'stableEndpoint' | 'observe' | 'stop'
  >
  transitions: Pick<ServerTransitions, 'outcome'>
}) {
  const { db, runtime, transitions } = deps
  /** Where the last settled reconcile pass began; null until this process has made one. */
  let reconciledFrom: Date | null = null
  /** When reconcile last read all compute. */
  let fullPassAt = 0

  /**
   * `reconcile` (§2, §9): what changed at the provider since the last pass, from one listing of
   * the deployment's compute rather than a call per server, mapped onto each server's last
   * observation. Only a server's current compute speaks for it: what a restore or a move
   * replaced says nothing. A change the previous observation doesn't already hold is acted on:
   *  - a running server whose workload stopped on its own crashed (`stopped{crash}`); the
   *    provider is asked once for the exit, so an out-of-memory kill comes with a bigger size;
   *  - compute running behind a server that holds none (stopped or failed, with nothing in
   *    flight) is stopped: nobody can reach it, and nothing counts it.
   * Windows overlap, and a pass that didn't settle everything is read again. The first pass after
   * a start, one an hour, and one whose clock is behind the last, read everything, so nothing
   * waits on a change that never comes.
   */
  const reconcile = async (now: Date): Promise<void> => {
    const from = reconciledFrom
    const full = from === null || now < from || now.getTime() - fullPassAt >= FULL_PASS_MS
    const since = full || from === null ? new Date(0) : from
    let settled = true
    for await (const { key, handle, observation } of runtime.observeChanged(since)) {
      if (!SERVER_ID.test(key)) continue
      if (!(await observed(key, handle, observation))) settled = false
    }
    if (!settled) return
    reconciledFrom = now
    if (full) fullPassAt = now.getTime()
  }

  /** One observation of a server's compute. False when it must be looked at again. */
  const observed = async (
    serverId: string,
    handle: RuntimeHandle,
    seen: RuntimeObservation,
  ): Promise<boolean> => {
    const server = await findServer(db, serverId)
    // Compute no server owns is the orphan sweep's.
    if (server === null) return true
    const binding = await loadRuntime(db, serverId, runtime.providers)
    if (binding.handle === null || !runtime.sameCompute(binding.handle, handle)) return true
    // The same compute listed under another handle, where endpoints move: a running server's
    // may have come back elsewhere. The listing can be older than a start that saved since, so the
    // provider is asked about the handle held now. Only a running server's address is routed.
    if (
      !runtime.stableEndpoint(binding.handle) &&
      server.lifecycle.status === 'running' &&
      handle !== binding.handle
    )
      await moved(serverId, binding.handle)
    if (seen.hostLost) {
      if (binding.observed?.detail !== HOST_LOST) await recordHostLost(db, serverId, seen)
      return true
    }
    const previous = binding.observed
    if (previous !== null && previous.state === seen.state && seen.at.getTime() <= Date.parse(previous.at))
      return true
    const status = server.lifecycle.status
    if (status === 'running' && EXITED.has(seen.state)) return crashed(serverId, binding.handle)
    if (HOLDS_NONE.has(status) && seen.state === 'running') return stray(serverId, binding.handle)
    await saveObserved(db, serverId, observedJson(seen))
    return true
  }

  /** Compute the provider brought back at another address: its new handle, unless one was saved since. */
  const moved = async (serverId: string, held: RuntimeHandle): Promise<void> => {
    const seen = await runtime.observe(held).catch(() => null)
    const moved = seen?.handle
    if (moved === undefined) return
    await db.transaction(async (tx) => {
      if ((await lockServer(tx, serverId)) === null) return
      if ((await loadRuntime(tx, serverId, runtime.providers)).handle !== held) return
      await saveHandle(tx, serverId, moved)
      await tx.insert(schema.auditLog).values({
        actor: 'system:reconcile',
        action: 'server.readdressed',
        subjectType: 'server',
        subjectId: serverId,
        data: {},
      })
    })
  }

  /**
   * A running server's workload was listed stopped. The listing can be behind and carries no
   * exit, so the provider is asked about this one before it is called a crash.
   */
  const crashed = async (serverId: string, handle: RuntimeHandle): Promise<boolean> => {
    const now = await runtime.observe(handle)
    await db.transaction(async (tx) => {
      await saveObserved(tx, serverId, observedJson(now))
      if (!EXITED.has(now.state)) return
      const locked = await lockServer(tx, serverId)
      if (locked?.lifecycle.status !== 'running') return
      // The run ends when the workload did, never before it began.
      const began = (await openIntervalStart(tx, serverId))?.getTime() ?? 0
      await closeInterval(tx, serverId, new Date(Math.max(now.at.getTime(), began)))
      await clearPresence(tx, serverId)
      await transitions.outcome(tx, locked, { type: 'crashed' })
    })
    return true
  }

  /**
   * Compute running behind a server that holds none: a start that failed without stopping it,
   * or a change made at the provider. It stops with the server's row held, so a start asked for
   * meanwhile waits for it instead of being stopped under it; with other work in flight on the
   * server, it is looked at again next pass.
   */
  const stray = async (serverId: string, handle: RuntimeHandle): Promise<boolean> => {
    return db.transaction(async (tx) => {
      const locked = await lockServer(tx, serverId)
      if (locked === null || !HOLDS_NONE.has(locked.lifecycle.status)) return true
      if ((await activeOperation(tx, serverId)) !== null) return false
      const binding = await loadRuntime(tx, serverId, runtime.providers)
      if (binding.handle === null || !runtime.sameCompute(binding.handle, handle)) return true
      await runtime.stop(binding.handle)
      await saveObserved(tx, serverId, observedJson(await runtime.observe(binding.handle)))
      await tx.insert(schema.auditLog).values({
        actor: 'system:reconcile',
        action: 'server.stray_compute_stopped',
        subjectType: 'server',
        subjectId: serverId,
        data: { status: locked.lifecycle.status },
      })
      return true
    })
  }

  return reconcile
}
