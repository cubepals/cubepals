/**
 * Asks for the moves the platform makes on its own, a few a pass: a server whose region now maps
 * elsewhere, one whose host has been lost past its grace, and one an operator asked to move to
 * another runtime. Noticing a lost host is `reconcile.ts`'s and `presence.ts`'s; making a move is
 * the `relocate` operation's (`handlers/moving.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { AppError, NotFound } from '../../errors.ts'
import { runtimeKey } from '../../ports/runtime.ts'
import { pendingMoves, rebind } from '../../runtimes/persistence.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import type { RuntimePlacement } from '../../runtimes/service.ts'
import {
  findServer,
  HOST_LOST,
  listByStatus,
  loadRuntime,
  lockServer,
  saveObserved,
} from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import { presenceFor } from '../../servers/usage.ts'
import { activeOperation, relocationFailures } from '../persistence.ts'
import { observedJson } from './observations.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long a host may stay unreachable before its server is rebuilt elsewhere (§9): hosts come back. */
export const HOST_LOSS_GRACE_MS = 10 * 60_000
/**
 * How long after a move was refused, or failed, before the relocation sweep asks for it again: twice
 * as long after each one in a row, up to `RELOCATION_RETRY_MAX_MS`.
 */
export const RELOCATION_RETRY_MS = 15 * 60_000
const RELOCATION_RETRY_MAX_MS = DAY_MS

/** Whether moves that failed one after another, newest first, still hold off the next. */
function retryLater(failures: readonly Date[], now: Date): boolean {
  const [last] = failures
  if (last === undefined) return false
  const wait = Math.min(RELOCATION_RETRY_MS * 2 ** (failures.length - 1), RELOCATION_RETRY_MAX_MS)
  return now.getTime() - last.getTime() < wait
}

export function relocating(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'runs' | 'isPlaced' | 'observe' | 'hasRoom' | 'adopt' | 'destroy'>
  specs: Pick<RuntimeSpecs, 'desired'>
  /** Records how an operator's move of a resting server between runtimes ended. */
  placement: Pick<RuntimePlacement, 'moveEnded'>
  service: Pick<MinecraftServerService, 'relocateForPlatform'>
}) {
  const { db, runtime, specs, placement, service } = deps

  /**
   * The relocation triggers besides a person's choice (§9), a few at a time:
   *  - a server whose product region now maps elsewhere (its provider region was deprecated and
   *    the region remapped) moves there; a running one only while nobody plays on it;
   *  - one whose host has been lost for longer than `HOST_LOSS_GRACE_MS` is rebuilt elsewhere in
   *    its region from its newest snapshot, whoever was on it, since nobody can reach it anyway.
   * Each goes only once where it is going has room for it: until then it waits as it is, and the
   * next sweep asks again.
   */
  const relocations = async (now: Date, limit: number): Promise<number> => {
    let moved = 0
    // Asked once a sweep for each runtime, region and size: a lost host's servers ask once.
    const full = new Set<string>()
    const candidates = [
      ...(await listByStatus(db, 'running')),
      ...(await listByStatus(db, 'stopped')),
      ...(await listByStatus(db, 'failed')),
    ]
    const online = await presenceFor(
      db,
      candidates.map((s) => s.id),
    )
    for (const server of candidates) {
      if (moved >= limit) break
      // A move the platform made that failed is its owner's to try again, not the sweep's.
      if (server.lifecycle.failure?.during === 'relocating') continue
      const binding = await loadRuntime(db, server.id, runtime.providers)
      if (binding.handle === null) continue
      const observed = binding.observed
      const lost =
        observed?.detail === HOST_LOST && now.getTime() - Date.parse(observed.at) >= HOST_LOSS_GRACE_MS
      // Another runtime an operator asked for (docs/runtimes.md); never one the sweep chose itself.
      const toRuntime =
        binding.moveTo !== null &&
        binding.moveTo !== binding.provider &&
        runtime.runs(binding.moveTo) &&
        server.lifecycle.status !== 'failed'
          ? binding.moveTo
          : null
      const misplaced =
        toRuntime !== null || !runtime.isPlaced(binding.handle, { regionKey: server.regionKey })
      if (!lost && !misplaced) continue
      if (!lost && server.lifecycle.status === 'running' && (online.get(server.id)?.length ?? 0) > 0) continue
      if ((await activeOperation(db, server.id)) !== null) continue
      // A move refused or failed lately waits before the sweep asks again, longer each time in a row:
      // what refused it (a world too big to move, room that went meanwhile) seldom changes by the
      // minute, and each try snapshots the world first. A lost host's rebuild doesn't wait: nobody
      // can play until it happens, and it is asked for only with room.
      if (!lost && retryLater(await relocationFailures(db, server.id, 8), now)) continue
      if (lost) {
        // Asked once more before a rebuild takes the world back to its last snapshot: a host
        // that answers was only out of reach for a while, and its server stays where it is.
        const seen = await runtime.observe(binding.handle).catch(() => null)
        if (seen !== null && !seen.hostLost) {
          await saveObserved(db, server.id, observedJson(seen))
          continue
        }
      }
      // A move or a rebuild with nowhere to go would only be refused: it waits for room instead.
      const to = toRuntime ?? binding.provider
      const { spec } = await specs.desired(db, server)
      const size = { memoryMb: spec.resources.memoryMb, storageGb: spec.storage.sizeGb }
      const where = `${to} ${server.regionKey} ${size.memoryMb} ${size.storageGb}`
      if (full.has(where)) continue
      if (!(await runtime.hasRoom(to, { regionKey: server.regionKey }, size).catch(() => false))) {
        full.add(where)
        continue
      }
      try {
        if (lost) await service.relocateForPlatform(server.id, 'host')
        else if (toRuntime !== null) await service.relocateForPlatform(server.id, 'runtime', toRuntime)
        else await service.relocateForPlatform(server.id, 'region')
        moved++
      } catch (error) {
        // One that changed meanwhile, or can't be moved now, never holds up the others.
        if (!(error instanceof AppError || error instanceof NotFound)) throw error
      }
    }
    for (const { serverId, to } of await pendingMoves(db)) {
      if (moved >= limit) break
      if (await moveResting(serverId, to)) moved++
    }
    return moved
  }

  /**
   * A resting server an operator asked to move to another runtime (docs/runtimes.md). Its world is
   * only in the archive store, which every runtime reads, so the move is its binding changing to a
   * handle the other runtime adopts, under the server's lock with nothing in flight for it: it
   * wakes there. False for any server that isn't resting, or that changed meanwhile.
   */
  const moveResting = async (serverId: string, to: string): Promise<boolean> => {
    const server = await findServer(db, serverId)
    if (server === null || server.lifecycle.status !== 'stored') return false
    if (!runtime.runs(to) || (await activeOperation(db, serverId)) !== null) return false
    const binding = await loadRuntime(db, serverId, runtime.providers)
    if (binding.foreign || binding.provider === to) return false
    const { spec } = await specs.desired(db, server)
    const adopted = await runtime.adopt(to, runtimeKey(serverId), { regionKey: server.regionKey }, spec)
    const switched = await db.transaction(async (tx) => {
      const locked = await lockServer(tx, serverId)
      if (locked?.lifecycle.status !== 'stored') return false
      if ((await activeOperation(tx, serverId)) !== null) return false
      const current = await loadRuntime(tx, serverId, runtime.providers)
      if (current.provider !== binding.provider || current.moveTo !== to) return false
      await rebind(tx, serverId, to, adopted, server.regionKey)
      await placement.moveEnded(tx, serverId, {
        moved: true,
        from: binding.provider,
        to,
        reason: 'it was resting: its world was in the archive store already',
      })
      await tx.insert(schema.auditLog).values({
        actor: 'system:relocate',
        action: 'server.runtime_moved',
        subjectType: 'server',
        subjectId: serverId,
        data: { from: binding.provider, to, resting: true },
      })
      return true
    })
    if (!switched) {
      await runtime.destroy(to, adopted).catch(() => undefined)
      return false
    }
    // What the old runtime kept for it (an app, a released placement) goes; the orphan sweep
    // finishes what this doesn't.
    if (binding.handle !== null)
      await runtime.destroy(binding.provider, binding.handle).catch(() => undefined)
    return true
  }

  return relocations
}
