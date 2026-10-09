/**
 * Moves a server (§9): to another region, off a host that was lost (rebuilt from its newest
 * snapshot, its owner told), or onto another runtime through the archive store. A move the runtime
 * refuses before it lets go of anything leaves the server where it was. Choosing when a server
 * moves is `schedules.ts`'s and `RuntimePlacement`'s.
 */
import { type Db, schema } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { markReseed } from '../../access/persistence.ts'
import type { AccessReconciler } from '../../access/reconciler.ts'
import { emailOf } from '../../accounts/persistence.ts'
import { type BackupRecord, expireSnapshotsOf, listBackups, setExpiry } from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import { aside, inFull, PermanentFailure } from '../../errors.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import type { Mailer } from '../../ports/platform.ts'
import {
  type ProgressSink,
  RuntimeFull,
  type RuntimeHandle,
  RuntimeUnsupported,
  runtimeKey,
} from '../../ports/runtime.ts'
import { rebind, setMoveTo } from '../../runtimes/persistence.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import type { RuntimePlacement } from '../../runtimes/service.ts'
import {
  loadRuntime,
  lockServer,
  type RuntimeBinding,
  saveHandle,
  saveObserved,
  setDesired,
} from '../../servers/persistence.ts'
import type { DesiredRuntime, RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { clearPresence, closeInterval, openInterval } from '../../servers/usage.ts'
import { enqueuePrune } from '../../worlds/service.ts'
import type { BootSequence } from '../boot.ts'
import {
  NoLongerApplies,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '../runner.ts'
import { appliedConfig, type ServerBinding } from './binding.ts'
import type { GameConsole } from './game-console.ts'
import type { Rechecks } from './rechecks.ts'
import { IMPORT_LINK_SECONDS, KEPT_AFTER_WAKING_MS, type WorldCopies } from './world-copies.ts'

export function moving(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'observe' | 'relocate' | 'destroy' | 'stop' | 'adopt' | 'restore'>
  specs: Pick<RuntimeSpecs, 'desired'>
  access: Pick<AccessReconciler, 'reconcile'>
  boot: Pick<BootSequence, 'run'>
  transitions: ServerTransitions
  placement: Pick<RuntimePlacement, 'moveEnded'>
  archives: ArchiveStore | null
  backups: Pick<BackupService, 'enforceRetention'>
  mailer: Pick<Mailer, 'send'>
  webOrigin: string
  bindingOf: ServerBinding['bindingOf']
  progressSink: ServerBinding['progressSink']
  startCompute: ServerBinding['startCompute']
  booted: ServerBinding['booted']
  stopWhatFailed: ServerBinding['stopWhatFailed']
  mayBoot: Rechecks['mayBoot']
  preflight: Rechecks['preflight']
  windDown: GameConsole['windDown']
  capture: WorldCopies['capture']
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
    stopWhatFailed,
    mayBoot,
    preflight,
    windDown,
    capture,
    archiveCopy,
  } = deps

  /**
   * The server in another region (§9): a snapshot first, then the provider moves storage and
   * compute, keeping the original until the move succeeds. The volume's contents move as they
   * are, so access stays continuous. A move with nowhere to go leaves the server as it was.
   */
  const relocate: OperationHandler = {
    kind: 'relocate',
    phase: 'relocating',
    runsWhen: ['relocating'],
    abandon: stopWhatFailed(['relocating']),
    async run(ctx) {
      const server = ctx.server
      const input = ctx.op.input as {
        regionKey: string
        running: boolean
        fromFailure?: boolean
        /** The host it was on was lost (§9): rebuilt from its newest snapshot, elsewhere in its region. */
        hostLost?: boolean
        /** Another runtime an operator asked it to move to (docs/runtimes.md). */
        toProvider?: string
      }
      const { up, refusal } = await mayBoot(server, input)
      const binding = await bindingOf(server.id)
      if (binding.handle === null) throw new PermanentFailure('This server has nothing to move yet.')
      const desired = await specs.desired(db, server)
      await preflight(desired, binding.applied)
      if (input.toProvider !== undefined && input.toProvider !== binding.provider)
        return rehost(ctx, server, binding, binding.handle, desired, input.toProvider, { up, refusal })
      // A lost host can't be asked anything: no in-game changes to bring in, no snapshot to take.
      const rebuildFrom = input.hostLost ? await newestSnapshot(server) : null
      if (input.hostLost && rebuildFrom === null)
        throw new PermanentFailure("This server's host was lost, and it has no snapshot to rebuild from.")
      if (!input.hostLost && binding.applied !== null) {
        if (input.running)
          await deps.access.reconcile(server, binding.handle, 'import').catch(() => undefined)
        await ctx.step('saving')
        await capture(server, binding.handle, binding.applied, 'pre_relocate')
      }
      await ctx.step('storage')
      const there = { ...server, regionKey: input.regionKey }
      let handle: RuntimeHandle
      try {
        handle = await runtime.relocate(
          binding.handle,
          { regionKey: input.regionKey },
          desired.spec,
          progressSink(ctx, there),
          rebuildFrom?.snapshotHandle ?? undefined,
        )
      } catch (error) {
        // No room there, or a runtime that can't move this server at all (a world too big to
        // copy): either way it was refused before anything was let go.
        if (!(error instanceof RuntimeFull || error instanceof RuntimeUnsupported)) throw error
        if (!(await stayPut(server, binding.handle, input.hostLost === true))) throw error
        await deps.backups.enforceRetention(server)
        return {
          status: 'failed',
          reason: input.hostLost
            ? 'The computer it ran on stopped answering, and there was no room on another just then. It moves as soon as there is.'
            : `It stayed where it was: the move didn't finish${aside(error)}.`,
          detail: inFull(error),
        }
      }
      await saveHandle(db, server.id, handle, input.regionKey)
      if (rebuildFrom !== null) {
        // The snapshot's access files may be older than Blockly's record: every entry goes again.
        await markReseed(db, server.id)
        await saveObserved(db, server.id, { state: 'stopped', at: new Date().toISOString() })
      }
      if (up) {
        const started = await startCompute(server.id, handle)
        await boot.run(ctx, there, started, desired.revision)
      }
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'relocating') return
        const moved = await setDesired(tx, locked, { regionKey: input.regionKey })
        if (up) {
          await booted(tx, server.id, appliedConfig(moved, desired))
          await openInterval(tx, server.id, moved.memoryTier, new Date())
        }
        const relocated = await transitions.outcome(tx, moved, {
          type: 'relocated',
          running: up,
          ...(refusal === null ? {} : { reason: 'policy' as const }),
        })
        if (up) await enqueuePrune(tx, transitions, relocated)
      })
      await deps.backups.enforceRetention(server)
      if (rebuildFrom !== null) await rebuilt(server, rebuildFrom)
      if (refusal !== null)
        return { status: 'failed', reason: `The server moved, but stayed off: ${refusal}` }
      return { status: 'succeeded' }
    },
  }

  /**
   * A move the runtime refused for want of room, before it let go of anything (§9): the server
   * settles back as the runtime left it, in its region, running if it still runs there. One whose
   * host was lost stays stopped, for the relocation sweep to rebuild once there is room. False when
   * the runtime went on with the move after all (a new handle, or nothing behind the old one): only
   * finishing it mends that, so it fails as any move does.
   */
  const stayPut = async (server: MinecraftServer, from: RuntimeHandle, hostLost: boolean) => {
    if ((await loadRuntime(db, server.id, runtime.providers)).handle !== from) return false
    const seen = await runtime.observe(from).catch(() => null)
    if (seen === null || seen.state === 'absent') return false
    const running = !hostLost && seen.state === 'running'
    await db.transaction(async (tx) => {
      const locked = await lockServer(tx, server.id)
      if (locked === null || locked.lifecycle.status !== 'relocating') return
      // Off is off: its time stops counting and nobody is on it.
      if (!running) {
        await closeInterval(tx, server.id, new Date())
        await clearPresence(tx, server.id)
      }
      await transitions.outcome(tx, locked, { type: 'relocated', running })
    })
    return true
  }

  /**
   * A server onto another runtime (docs/runtimes.md), which only an operator asks for. Its world
   * goes through the archive store, the one place every runtime reads, so nothing of one provider
   * is ever handed to another: the server stops, a copy is made and read back, and the other
   * runtime builds storage and compute from it. Only once that runtime holds the world does the
   * server's binding change; a move that fails before then leaves the server where it was, with
   * its world, running again if it ran. What it had on the old runtime goes after the change.
   */
  const rehost = async (
    ctx: OperationContext,
    server: MinecraftServer,
    binding: RuntimeBinding,
    from: RuntimeHandle,
    desired: DesiredRuntime,
    to: string,
    { up, refusal }: { up: boolean; refusal: string | null },
  ): Promise<OperationResult> => {
    const archives = deps.archives
    if (archives === null)
      throw new PermanentFailure(
        'This deployment keeps no archives, so a server can’t move between runtimes.',
      )
    if (binding.applied === null) throw new PermanentFailure('This server has no world to move yet.')
    const key = runtimeKey(server.id)
    const placement = { regionKey: server.regionKey }
    // Whatever an earlier attempt left on the other runtime goes first: this one starts clean.
    await runtime.destroy(to, key).catch(() => undefined)
    await ctx.step('saving')
    if ((await runtime.observe(from)).state === 'running') {
      await deps.access.reconcile(server, from, 'import').catch(() => undefined)
      await windDown(server, from)
      await runtime.stop(from)
    }
    let moved: RuntimeHandle
    let copy: BackupRecord
    try {
      copy = await archiveCopy(server, from, binding.applied, 'pre_relocate')
      await setExpiry(db, copy.id, new Date(Date.now() + KEPT_AFTER_WAKING_MS))
      await ctx.step('storage')
      if (copy.archiveKey === null) throw new Error('The copy has no place in the store')
      const vacant = await runtime.adopt(to, key, placement, desired.spec)
      const download = await archives.presignGet(copy.archiveKey, IMPORT_LINK_SECONDS, 'runtime')
      // Its handle is kept only once the world is there: until then the server is where it was, and
      // a crash leaves what this made to the orphan sweep, since the server is bound elsewhere.
      const held: ProgressSink = { step: (name) => ctx.step(name), handle: async () => {} }
      moved = await runtime.restore(
        vacant,
        { kind: 'archive', download, sha256: copy.sha256 },
        desired.spec,
        held,
      )
    } catch (error) {
      // Sent to the trash meanwhile: the decommission behind this takes what is left.
      if (error instanceof NoLongerApplies) throw error
      await runtime.destroy(to, key).catch(() => undefined)
      await deps.placement.moveEnded(db, server.id, {
        moved: false,
        from: binding.provider,
        to,
        reason: inFull(error),
      })
      await setMoveTo(db, server.id, null)
      let running = up
      if (up) {
        try {
          const back = await startCompute(server.id, from)
          await boot.run(ctx, server, back, desired.revision)
        } catch (again) {
          // No room to run it again where it was, just now: it waits there, stopped, as a start
          // with no room does.
          if (!(again instanceof RuntimeFull)) throw again
          running = false
        }
      }
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'relocating') return
        if (running) {
          await booted(tx, server.id, appliedConfig(locked, desired))
          await openInterval(tx, server.id, locked.memoryTier, new Date())
        }
        await transitions.outcome(tx, locked, { type: 'relocated', running })
      })
      return {
        status: 'failed',
        reason: `It stayed where it was: the move didn't finish${aside(error)}.`,
        detail: inFull(error),
      }
    }
    await db.transaction(async (tx) => {
      await lockServer(tx, server.id)
      await rebind(tx, server.id, to, moved, server.regionKey)
      // Its snapshots were taken where it was, and nothing restores them here; the copy does.
      await expireSnapshotsOf(tx, server.id)
      await deps.placement.moveEnded(tx, server.id, {
        moved: true,
        from: binding.provider,
        to,
        reason: `through the archive copy ${copy.id}`,
      })
      await tx.insert(schema.auditLog).values({
        actor: 'system:relocate',
        action: 'server.runtime_moved',
        subjectType: 'server',
        subjectId: server.id,
        data: { from: binding.provider, to, backupId: copy.id, sizeBytes: copy.sizeBytes },
      })
    })
    // The copy's access files are as old as the copy: who can join is put back on them at boot.
    await markReseed(db, server.id)
    // The old runtime's copy of the world goes; the orphan sweep finishes what this doesn't.
    await runtime.destroy(binding.provider, from).catch(() => undefined)
    if (up) {
      const started = await startCompute(server.id, moved)
      await boot.run(ctx, server, started, desired.revision)
    }
    await db.transaction(async (tx) => {
      const locked = await lockServer(tx, server.id)
      if (locked === null || locked.lifecycle.status !== 'relocating') return
      if (up) {
        await booted(tx, server.id, appliedConfig(locked, desired))
        await openInterval(tx, server.id, locked.memoryTier, new Date())
      }
      const relocated = await transitions.outcome(tx, locked, {
        type: 'relocated',
        running: up,
        ...(refusal === null ? {} : { reason: 'policy' as const }),
      })
      if (up) await enqueuePrune(tx, transitions, relocated)
    })
    await deps.backups.enforceRetention(server)
    if (refusal !== null) return { status: 'failed', reason: `The server moved, but stayed off: ${refusal}` }
    return { status: 'succeeded' }
  }

  /** The newest snapshot of the world the server plays, the one a lost host is rebuilt from. */
  const newestSnapshot = async (server: MinecraftServer) =>
    (await listBackups(db, server.id))
      .filter(
        (b) =>
          b.tier === 'snapshot' &&
          b.status === 'ready' &&
          b.snapshotHandle !== null &&
          b.worldId === server.activeWorldId,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null

  /** A rebuild from a backup loses what was played since: the owner is told, and it is audited. */
  const rebuilt = async (server: MinecraftServer, from: BackupRecord) => {
    await db.insert(schema.auditLog).values({
      actor: 'system:reconcile',
      action: 'server.rebuilt_from_backup',
      subjectType: 'server',
      subjectId: server.id,
      data: { backupId: from.id, takenAt: from.createdAt.toISOString() },
    })
    const to = await emailOf(db, server.ownerId)
    if (to === null) return
    await deps.mailer.send({
      to,
      subject: `“${server.name}” was moved after the computer it ran on failed`,
      text: [
        `The computer your server ${server.name} ran on stopped answering, so Cubepals moved it to another one in the same place.`,
        '',
        `It came back from its backup of ${from.createdAt.toUTCString()}. Anything built or changed in the world after that is gone. Who can join is as you set it.`,
        '',
        `${deps.webOrigin}/servers/${server.id}`,
      ].join('\n'),
    })
  }

  return relocate
}
