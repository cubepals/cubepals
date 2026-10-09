/**
 * Puts a running server onto a new configuration (§9), with a way back: settings the game takes
 * as people play go by command, anything else waits for a snapshot when it rewrites the world,
 * then the provider applies it and the server boots. Going back is `going-back.ts`'s; a stopped
 * server takes its change at its next start (`bringing-up.ts`).
 */
import type { Db } from '@blockly/db'
import { describeChanges } from '../../../domain/revision/revision.ts'
import { resetHeartsCommand } from '../../../minecraft/lifesteal.ts'
import { type ArtifactService, ArtifactUnavailable } from '../../artifacts/service.ts'
import type { BackupRecord } from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import { aside, inFull, PermanentFailure } from '../../errors.ts'
import type { ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { loadRevision, lockServer, saveHandle } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { closeInterval, openInterval } from '../../servers/usage.ts'
import { enqueuePrune } from '../../worlds/service.ts'
import type { BootSequence } from '../boot.ts'
import { takeLive } from '../live-settings.ts'
import { NoLongerApplies, type OperationHandler } from '../runner.ts'
import { appliedConfig, type ServerBinding } from './binding.ts'
import type { GameConsole } from './game-console.ts'
import type { GoingBack } from './going-back.ts'
import type { Rechecks } from './rechecks.ts'
import type { WorldCopies } from './world-copies.ts'

interface UpdateInput {
  /** Bringing a failed server back onto a change. */
  fromFailure?: boolean
  /** A new season (`WorldService.freshStart`): everyone's hearts go with the world it leaves. */
  resetHearts?: boolean
}

/**
 * A new season's hearts, forgotten after the snapshot that keeps them and before the restart that
 * ends the season. If it fails, the update goes back as one that doesn't start does, snapshot and
 * all, so the season carries on as it was.
 */
async function forgetHearts(runtime: Pick<Runtimes, 'exec'>, handle: RuntimeHandle, input: UpdateInput) {
  if (input.resetHearts !== true) return
  const reset = await runtime.exec(handle, resetHeartsCommand(), 60)
  if (reset.exitCode !== 0) throw new Error(`Resetting the hearts failed: ${reset.stderr.trim()}`)
}

export function updating(deps: {
  db: Db
  runtime: Pick<Runtimes, 'apply' | 'stop' | 'exec'>
  /** This and `console` whole, as `takeLive` takes them. */
  specs: RuntimeSpecs
  console: ServerConsole
  transitions: ServerTransitions
  boot: Pick<BootSequence, 'run'>
  artifacts: Pick<ArtifactService, 'preflight'>
  backups: Pick<BackupService, 'enforceRetention'>
  bindingOf: ServerBinding['bindingOf']
  startCompute: ServerBinding['startCompute']
  booted: ServerBinding['booted']
  stopWhatFailed: ServerBinding['stopWhatFailed']
  mayBoot: Rechecks['mayBoot']
  consoleTarget: GameConsole['consoleTarget']
  capture: WorldCopies['capture']
  rollBack: GoingBack['rollBack']
  putBack: GoingBack['putBack']
}) {
  const {
    db,
    runtime,
    transitions,
    specs,
    boot,
    artifacts,
    bindingOf,
    startCompute,
    booted,
    stopWhatFailed,
    mayBoot,
    consoleTarget,
    capture,
    rollBack,
    putBack,
  } = deps

  /**
   * A new configuration on a running server (§9): a snapshot first, then the provider applies
   * it and the server boots. If it doesn't come up, the configuration it ran before goes back
   * once, with the world from the snapshot when the change rewrote it, and what the server
   * should run returns to what it runs. Only if going back fails too is the server failed.
   */
  const apply: OperationHandler = {
    kind: 'apply',
    phase: 'updating',
    runsWhen: ['updating'],
    abandon: stopWhatFailed(['updating']),
    async run(ctx) {
      const server = ctx.server
      const input = ctx.op.input as UpdateInput
      const fromFailure = input.fromFailure === true
      const binding = await bindingOf(server.id)
      const previous = binding.applied
      if (binding.handle === null || previous === null)
        throw new PermanentFailure('This server has nothing running to update.')
      const { refusal } = await mayBoot(server, { running: true, fromFailure })
      if (refusal !== null) {
        await runtime.stop(binding.handle)
        await db.transaction(async (tx) => {
          const locked = await lockServer(tx, server.id)
          if (locked?.lifecycle.status === 'updating')
            await transitions.outcome(tx, locked, { type: 'updated', running: false, reason: 'policy' })
        })
        return { status: 'failed', reason: `The server stayed off: ${refusal}` }
      }
      let desired = await specs.desired(db, server)
      // Settings the game takes as people play reach it without a restart.
      if (
        !fromFailure &&
        (await takeLive(deps, server, consoleTarget(server, binding.handle), previous, desired))
      )
        return { status: 'succeeded' }
      try {
        await artifacts.preflight(desired.revision)
      } catch (error) {
        if (!(error instanceof ArtifactUnavailable)) throw error
        // Nothing was touched: the server keeps running what it ran, and should run it.
        await putBack(server, previous)
        return { status: 'failed', reason: `Nothing changed: ${error.message}` }
      }
      // A snapshot first, unless only settings change on the same world: those leave the disk as a
      // restart does, which takes none, and going back from them puts back the settings, not the
      // snapshot. Fly finishes a snapshot about 70 s after it is asked for and says nothing of when
      // it captured the disk: on staging (2026-09-28) one held writes made 4 s after the ask. So a
      // change that needs one waits for all of it, and one that doesn't skips it.
      const ran = await loadRevision(db, previous.revisionId)
      const settingsAlone =
        previous.worldId === desired.world.id &&
        ran.loaderVersion === desired.revision.loaderVersion &&
        describeChanges(ran, desired.revision).every((change) => change.field in ran.settings)
      let snapshot: BackupRecord | null = null
      if (!settingsAlone) {
        await ctx.step('saving')
        snapshot = await capture(server, binding.handle, previous, 'pre_apply')
      }
      await ctx.step('compute')
      try {
        await forgetHearts(runtime, binding.handle, input)
        const changed = await runtime.apply(binding.handle, desired.spec)
        if (changed !== binding.handle) await saveHandle(db, server.id, changed)
        // A failed server's workload may be down; apply restarts only one that runs.
        const handle = fromFailure ? await startCompute(server.id, changed) : changed
        // Its rollback starts it fresh on what ran before, so this boot doesn't start it again itself.
        await boot.run(
          ctx,
          server,
          handle,
          desired.revision,
          async () => {
            desired = await specs.desired(db, server)
            const next = await runtime.apply(handle, desired.spec)
            if (next !== binding.handle) await saveHandle(db, server.id, next)
            return startCompute(server.id, next)
          },
          { startAgainOnHang: false },
        )
      } catch (error) {
        // A server sent to the trash meanwhile has nothing to go back to.
        if (error instanceof NoLongerApplies) throw error
        await ctx.step('rolling_back')
        try {
          await rollBack(ctx, server, previous, desired, snapshot, 'updating', input.resetHearts === true)
        } catch (again) {
          if (again instanceof NoLongerApplies) throw again
          throw new PermanentFailure(
            `The new configuration didn't start${aside(error)}, and going back to the previous one failed too${aside(again)}.`,
            { cause: new Error(`${inFull(error)}; going back: ${inFull(again)}`) },
          )
        }
        return {
          status: 'failed',
          reason: `The new configuration didn't start${aside(error)}. Your server is back on the one before.`,
          detail: inFull(error),
        }
      }
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'updating') return
        await booted(tx, server.id, appliedConfig(locked, desired))
        const now = new Date()
        if (previous.memoryTier !== locked.memoryTier) {
          // Usage is counted by size: the old size's interval ends where the new one starts.
          await closeInterval(tx, server.id, now)
        }
        // Idempotent: a server brought back from a failure counts from now.
        await openInterval(tx, server.id, locked.memoryTier, now)
        const updated = await transitions.outcome(tx, locked, { type: 'updated', running: true })
        await enqueuePrune(tx, transitions, updated)
      })
      await deps.backups.enforceRetention(server)
      return { status: 'succeeded' }
    },
  }

  return apply
}
