/**
 * Rests a world nobody plays in the archive store, and wakes it from there (§15.5 stored worlds):
 * store and unstore share the copy a world rests in and the way back to resting. Making and
 * checking that copy is `world-copies.ts`; deciding which servers rest is the store sweep's
 * (`schedules.ts`). `WOKEN_BY` comes from `bringing-up.ts`: the one import between families, since
 * a wake is a start a connection asked for.
 */
import { type AppliedConfigJson, type Db, schema, type Tx } from '@blockly/db'
import { entitlementsFor } from '../../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { markReseed } from '../../access/persistence.ts'
import { loadControls, loadStanding } from '../../accounts/persistence.ts'
import { type BackupRecord, expireSnapshotsOf, setExpiry, storedCopy } from '../../backups/persistence.ts'
import { inFull, ownersWords, PermanentFailure } from '../../errors.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { loadRuntime, lockServer, markStored, saveHandle } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { openInterval } from '../../servers/usage.ts'
import { enqueuePrune } from '../../worlds/service.ts'
import type { BootSequence } from '../boot.ts'
import { openOfKinds, otherWork } from '../persistence.ts'
import { NoLongerApplies, type OperationHandler } from '../runner.ts'
import { appliedConfig, type ServerBinding } from './binding.ts'
import { WOKEN_BY } from './bringing-up.ts'
import type { Rechecks } from './rechecks.ts'
import { IMPORT_LINK_SECONDS, KEPT_AFTER_WAKING_MS, type WorldCopies } from './world-copies.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function storedWorlds(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'release' | 'restore'>
  specs: Pick<RuntimeSpecs, 'desired'>
  boot: Pick<BootSequence, 'run'>
  transitions: ServerTransitions
  events: Pick<EventBus, 'publish'>
  archives: ArchiveStore | null
  bindingOf: ServerBinding['bindingOf']
  progressSink: ServerBinding['progressSink']
  startCompute: ServerBinding['startCompute']
  booted: ServerBinding['booted']
  stillAllowed: Rechecks['stillAllowed']
  preflight: Rechecks['preflight']
  archiveCopy: WorldCopies['archiveCopy']
}) {
  const {
    db,
    runtime,
    transitions,
    specs,
    boot,
    bindingOf,
    progressSink,
    startCompute,
    booted,
    stillAllowed,
    preflight,
    archiveCopy,
  } = deps

  // A world nobody has played for as long as its plan says rests in the archive store, and its
  // server lets go of compute and storage, which is what an idle server costs.
  // The order is what keeps the world safe: a copy is made, and read back as far as its settings
  // and its world's level.dat, before anything is let go, and only under the server's lock, with
  // nobody having played since the copy and nothing else waiting for the server. A join or a start
  // brings it back from that copy.

  /** Why a server may not rest now, or null when it may. One an operator rests `now` may have been played. */
  const whyNotStore = async (server: MinecraftServer, now: Date, asked: boolean): Promise<string | null> => {
    if (!(await loadControls(db)).storingEnabled) return 'Resting worlds is paused.'
    const standing = await loadStanding(db, server.ownerId)
    const days = asked ? 0 : entitlementsFor(standing.plan, standing.limitOverrides).storeAfterIdleDays
    if (now.getTime() - server.lastActiveAt.getTime() < days * DAY_MS) return 'It was played recently.'
    return null
  }

  /**
   * The copy a world rests in. One made since anyone last played is the world as it is, and is
   * used again, which also makes a wake nobody joined cheap to undo. Otherwise a snapshot of the
   * stopped server is packed into the store, and read back before it counts as made.
   */
  const storedCopyFor = async (
    server: MinecraftServer,
    handle: RuntimeHandle,
    config: AppliedConfigJson,
  ): Promise<BackupRecord> => {
    const existing = await storedCopy(db, server.id)
    if (existing !== null && existing.createdAt >= server.lastActiveAt) return existing
    // Only a server asleep is rested: it saved its world as it stopped.
    return archiveCopy(server, handle, config, 'stored')
  }

  const store: OperationHandler = {
    kind: 'store',
    phase: null,
    // `storing`: a store that got as far as letting go, and is asked again, finishes from there.
    runsWhen: ['stopped', 'storing'],
    async run(ctx) {
      const server = ctx.server
      if (deps.archives === null) return { status: 'cancelled', reason: 'This deployment keeps no archives.' }
      const binding = await bindingOf(server.id)
      if (binding.handle === null || binding.applied === null)
        return { status: 'cancelled', reason: 'It has no world to rest.' }
      let copy: BackupRecord
      if (server.lifecycle.status === 'stopped') {
        const why = await whyNotStore(server, new Date(), ctx.op.input.now === true)
        if (why !== null) return { status: 'cancelled', reason: why }
        await ctx.step('saving')
        copy = await storedCopyFor(server, binding.handle, binding.applied)
        const refusal = await db.transaction(async (tx) => {
          const locked = await lockServer(tx, server.id)
          if (locked === null || locked.lifecycle.status !== 'stopped') return 'It isn’t asleep any more.'
          if (locked.lastActiveAt > copy.createdAt) return 'Someone played on it meanwhile.'
          if (await otherWork(tx, server.id, ctx.op.id)) return 'Something else is waiting for it.'
          await transitions.outcome(tx, locked, { type: 'storing' })
          return null
        })
        if (refusal !== null) {
          // The copy stays a while, as an ordinary backup of the world as it was.
          await setExpiry(db, copy.id, new Date(Date.now() + KEPT_AFTER_WAKING_MS))
          return { status: 'cancelled', reason: refusal }
        }
      } else {
        const verified = await storedCopy(db, server.id)
        if (verified === null) throw new PermanentFailure('The copy this world was resting in is missing.')
        copy = verified
      }
      // From here the copy is the world: it keeps no expiry, and only deleting the server ends it.
      await setExpiry(db, copy.id, null)
      await ctx.step('storage')
      const released = await runtime.release(binding.handle)
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null) return
        // Whatever the server is now — resting, or deleted meanwhile — its world is only in the
        // copy, and that is what it is recorded to have, so nothing boots it on empty storage.
        await saveHandle(tx, server.id, released, locked.regionKey)
        await expireSnapshotsOf(tx, server.id)
        await markStored(tx, server.id, new Date())
        if (locked.lifecycle.status === 'storing') await transitions.outcome(tx, locked, { type: 'stored' })
        await tx.insert(schema.auditLog).values({
          actor: 'system:store',
          action: 'server.stored',
          subjectType: 'server',
          subjectId: server.id,
          data: { backupId: copy.id, sizeBytes: copy.sizeBytes },
        })
        await deps.events.publish(tx, {
          type: 'backup_changed',
          serverId: server.id,
          ownerId: server.ownerId,
        })
      })
      return { status: 'succeeded' }
    },
    /**
     * A store that failed for good while letting go: its world is whole in the copy it verified,
     * so it rests from here, and wakes from that copy. Whatever the release left is cleared when
     * it does, since a restore replaces what the handle still names.
     */
    async abandon(op, reason, ended) {
      if (ended !== 'failed') return
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, op.serverId)
        if (locked?.lifecycle.status !== 'storing') return
        await expireSnapshotsOf(tx, op.serverId)
        await markStored(tx, op.serverId, new Date())
        await transitions.outcome(tx, locked, { type: 'stored' })
        await tx.insert(schema.auditLog).values({
          actor: 'system:store',
          action: 'server.store_incomplete',
          subjectType: 'server',
          subjectId: op.serverId,
          data: { reason },
        })
      })
    },
  }

  /**
   * A wake that didn't finish: whatever it made goes, and the server rests again, its copy
   * untouched, for the owner or the next join to try again. Only while `wakeId` is the wake
   * restoring it: see `anotherWake`.
   */
  const backToStored = async (serverId: string, wakeId: string, reason: string) => {
    const { handle } = await loadRuntime(db, serverId, runtime.providers)
    const released = handle === null ? null : await runtime.release(handle).catch(() => handle)
    await db.transaction(async (tx) => {
      const locked = await lockServer(tx, serverId)
      if (locked?.lifecycle.status !== 'restoring' || (await anotherWake(tx, serverId, wakeId))) return
      if (released !== null) await saveHandle(tx, serverId, released, locked.regionKey)
      await transitions.outcome(tx, locked, { type: 'stored' })
      await tx.insert(schema.auditLog).values({
        actor: 'system:store',
        action: 'server.wake_failed',
        subjectType: 'server',
        subjectId: serverId,
        data: { reason },
      })
    })
  }

  const unstore: OperationHandler = {
    kind: 'unstore',
    phase: 'restoring',
    runsWhen: ['restoring'],
    async run(ctx) {
      const server = ctx.server
      const decision = await stillAllowed(server, 'continue_starting')
      if (!decision.ok) {
        await backToStored(server.id, ctx.op.id, decision.message)
        return { status: 'cancelled', reason: decision.message }
      }
      const archives = deps.archives
      if (archives === null)
        throw new PermanentFailure(
          'This deployment keeps no archives, so a resting world can’t come back here.',
        )
      const copy = await storedCopy(db, server.id)
      if (copy === null || copy.archiveKey === null)
        throw new PermanentFailure('The copy this world was resting in is missing.')
      const binding = await bindingOf(server.id)
      if (binding.handle === null) throw new PermanentFailure('This server has nowhere to come back to.')
      const desired = await specs.desired(db, server)
      await preflight(desired, null)
      // The copy's access files are as old as the copy: who can join is put back on them at boot.
      await markReseed(db, server.id)
      try {
        const download = await archives.presignGet(copy.archiveKey, IMPORT_LINK_SECONDS, 'runtime')
        const restored = await runtime.restore(
          binding.handle,
          { kind: 'archive', download, sha256: copy.sha256 },
          desired.spec,
          progressSink(ctx, server),
        )
        await saveHandle(db, server.id, restored, server.regionKey)
        const started = await startCompute(server.id, restored)
        await boot.run(ctx, server, started, desired.revision)
      } catch (error) {
        // Sent to the trash while it woke: the decommission behind this takes what it made.
        if (error instanceof NoLongerApplies) throw error
        // What went wrong is the platform's to read; the owner reads that the world is safe.
        await backToStored(server.id, ctx.op.id, inFull(error))
        const words = ownersWords(error)
        return {
          status: 'failed',
          reason: `We couldn’t wake it just now${words === null ? '' : ` (${words})`}. Its world is safe; try again in a minute.`,
          detail: inFull(error),
        }
      }
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'restoring') return
        await booted(tx, server.id, appliedConfig(locked, desired))
        await openInterval(tx, server.id, locked.memoryTier, new Date(), ctx.op.requestedBy === WOKEN_BY)
        await markStored(tx, server.id, null)
        await setExpiry(tx, copy.id, new Date(Date.now() + KEPT_AFTER_WAKING_MS))
        const woke = await transitions.outcome(tx, locked, { type: 'restored', running: true })
        await enqueuePrune(tx, transitions, woke)
        await deps.events.publish(tx, {
          type: 'backup_changed',
          serverId: server.id,
          ownerId: server.ownerId,
        })
      })
      return { status: 'succeeded' }
    },
    /** Before the runner records a failure: it finds the server resting, and records none. */
    async abandon(op, reason, ended) {
      if (ended === 'failed') await backToStored(op.serverId, op.id, reason)
    },
  }

  return { store, unstore }
}

/**
 * Whether a wake other than `wakeId` waits or runs for the server. A failed wake is settled twice:
 * by `run`, which puts the world back to rest, then by the runner as it records the failure. A
 * join between the two starts the next wake, which the second must not undo: in production
 * (2026-10-11) it was cancelled as "No longer applies: the server is stored" while a player waited.
 * Leaving the server to it is safe: it runs next, and its restore replaces what the handle names.
 */
async function anotherWake(tx: Tx, serverId: string, wakeId: string): Promise<boolean> {
  return (await openOfKinds(tx, [serverId], ['unstore'])).some((wake) => wake.id !== wakeId)
}
