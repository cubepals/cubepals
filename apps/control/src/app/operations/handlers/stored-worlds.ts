// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rests a world nobody plays in the archive store, and wakes it from there (§15.5 stored worlds):
 * store and unstore share the copy a world rests in and the way back to resting. Making and
 * checking that copy is `world-copies.ts`; deciding which servers rest is the store sweep's
 * (`schedules.ts`).
 */
import { DAY_MS } from '@blockly/contracts/durations'
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
import { keptStorage } from '../../servers/kept-storage.ts'
import { loadRuntime, lockServer, markStored, saveHandle } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { openInterval } from '../../servers/usage.ts'
import { enqueuePrune } from '../../worlds/service.ts'
import type { BootSequence } from '../boot.ts'
import { openOfKinds, otherWork } from '../persistence.ts'
import { NoLongerApplies, type OperationContext, type OperationHandler } from '../runner.ts'
import { appliedConfig, type ServerBinding } from './binding.ts'
import type { Rechecks } from './rechecks.ts'
import { IMPORT_LINK_SECONDS, KEPT_AFTER_WAKING_MS, type WorldCopies } from './world-copies.ts'

/** Why a server keeping a rebuild's old storage doesn't rest: letting go would take that too. */
const KEEPING_REBUILDS_STORAGE =
  'It keeps its world’s copy from before a rebuild, in case the rebuild missed anything. It rests once that copy goes.'

export function storedWorlds(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'stop' | 'release' | 'restore'>
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
    if ((await keptStorage(db, server.id, now)).length > 0) return KEEPING_REBUILDS_STORAGE
    const standing = await loadStanding(db, server.ownerId)
    const days = asked ? 0 : entitlementsFor(standing.plan, standing.limitOverrides).storeAfterIdleDays
    if (now.getTime() - server.lastActiveAt.getTime() < days * DAY_MS) return 'It was played recently.'
    return null
  }

  /**
   * The copy a world rests in: a snapshot of the stopped server packed into the store, unless a
   * join has woken it by then (`stillApplies`). Every rest makes its own, since the world can
   * change with no play counted (a short visit, console commands, a restore).
   */
  const storedCopyFor = async (
    { server, stillApplies }: OperationContext,
    handle: RuntimeHandle,
    config: AppliedConfigJson,
  ): Promise<BackupRecord> =>
    // Only a server asleep rests, its world saved; one whose memory was kept stops for real first.
    runtime.stop(handle).then(() => archiveCopy(server, handle, config, 'stored', stillApplies))

  /**
   * A stopped server's rest, as far as its copy: made, and the server `storing` under its lock,
   * or why not, its copy then kept a while as an ordinary backup of the world as it was.
   */
  const startRest = async (
    ctx: OperationContext,
    handle: RuntimeHandle,
    config: AppliedConfigJson,
  ): Promise<BackupRecord | string> => {
    const { server } = ctx
    const why = await whyNotStore(server, new Date(), ctx.op.input.now === true)
    if (why !== null) return why
    await ctx.step('saving')
    const copy = await storedCopyFor(ctx, handle, config)
    const refusal = await db.transaction(async (tx) => {
      const locked = await lockServer(tx, server.id)
      if (locked === null || locked.lifecycle.status !== 'stopped') return 'It isn’t asleep any more.'
      if (locked.lastActiveAt > copy.createdAt) return 'Someone played on it meanwhile.'
      if (await otherWork(tx, server.id, ctx.op.id)) return 'Something else is waiting for it.'
      await transitions.outcome(tx, locked, { type: 'storing' })
      return null
    })
    if (refusal === null) return copy
    await setExpiry(db, copy.id, new Date(Date.now() + KEPT_AFTER_WAKING_MS))
    return refusal
  }

  const store: OperationHandler = {
    kind: 'store',
    phase: null,
    // `storing`: a store that got as far as letting go, and is asked again, finishes from there;
    // so does one whose server was taken out of the trash meanwhile, `stored` before it finished.
    runsWhen: ['stopped', 'storing', 'stored'],
    async run(ctx) {
      const server = ctx.server
      if (server.storedAt !== null) return { status: 'cancelled', reason: 'It is resting already.' }
      if (deps.archives === null) return { status: 'cancelled', reason: 'This deployment keeps no archives.' }
      const binding = await bindingOf(server.id)
      if (binding.handle === null || binding.applied === null)
        return { status: 'cancelled', reason: 'It has no world to rest.' }
      let copy: BackupRecord
      if (server.lifecycle.status === 'stopped') {
        const started = await startRest(ctx, binding.handle, binding.applied)
        if (typeof started === 'string') return { status: 'cancelled', reason: started }
        copy = started
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
        if (locked.lifecycle.status === 'stopped') await restsAfterUndelete(tx, transitions, locked, copy)
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
      if (ended === 'failed')
        await db.transaction((tx) => restsIncomplete(tx, transitions, op.serverId, reason))
    },
  }

  /**
   * A wake that didn't finish: whatever it made goes, and the server rests again, its copy
   * untouched, for the owner or the next join to try again. Only while `wakeId` is the wake
   * restoring it: see `anotherWake`. What the provider holds on to, the orphan sweep clears later.
   */
  const backToStored = async (serverId: string, wakeId: string, reason: string) => {
    const { handle } = await loadRuntime(db, serverId, runtime.providers)
    const released = handle === null ? null : await runtime.release(handle).catch(keptBy(serverId, handle))
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
        await openInterval(tx, server.id, locked.memoryTier, new Date(), ctx.op)
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
 * A store that failed for good while letting go: the server rests from here, `storing` as the
 * store left it, or `stored` already when it was taken out of the trash meanwhile.
 */
async function restsIncomplete(tx: Tx, transitions: ServerTransitions, serverId: string, reason: string) {
  const locked = await lockServer(tx, serverId)
  const undeleted = locked?.lifecycle.status === 'stored' && locked.storedAt === null
  if (locked === null || (locked.lifecycle.status !== 'storing' && !undeleted)) return
  await expireSnapshotsOf(tx, serverId)
  await markStored(tx, serverId, new Date())
  if (!undeleted) await transitions.outcome(tx, locked, { type: 'stored' })
  await tx.insert(schema.auditLog).values({
    actor: 'system:store',
    action: 'server.store_incomplete',
    subjectType: 'server',
    subjectId: serverId,
    data: { reason },
  })
}

/**
 * A server taken out of the trash while its rest let go of its storage came back asleep, on
 * storage it no longer has: it rests, as it would have, and wakes from the copy.
 */
async function restsAfterUndelete(
  tx: Tx,
  transitions: ServerTransitions,
  server: MinecraftServer,
  copy: BackupRecord,
): Promise<void> {
  const storing = await transitions.outcome(tx, server, { type: 'storing' })
  await transitions.outcome(tx, storing, { type: 'stored' })
  await tx.insert(schema.auditLog).values({
    actor: 'system:store',
    action: 'server.stored_after_undelete',
    subjectType: 'server',
    subjectId: server.id,
    data: { backupId: copy.id },
  })
}

/**
 * Whether a wake other than `wakeId` waits or runs for the server. A failed wake is settled twice:
 * by `run`, which puts the world back to rest, then by the runner as it records the failure. A
 * join between the two starts the next wake, which the second must not undo: in production
 * (2026-10-10) it was cancelled as "No longer applies: the server is stored" while a player waited.
 * Leaving the server to it is safe: it runs next, and its restore replaces what the handle names.
 */
async function anotherWake(tx: Tx, serverId: string, wakeId: string): Promise<boolean> {
  return (await openOfKinds(tx, [serverId], ['unstore'])).some((wake) => wake.id !== wakeId)
}

/**
 * A failed wake's release that failed in turn: the handle stays as it was, and what it names is
 * the orphan sweep's (`schedules/leftovers.ts`), said in the log rather than dropped.
 */
function keptBy(serverId: string, handle: RuntimeHandle) {
  return (error: unknown): RuntimeHandle => {
    console.warn(
      `unstore: ${serverId} still holds what a failed wake made; the orphan sweep clears it`,
      error,
    )
    return handle
  }
}
