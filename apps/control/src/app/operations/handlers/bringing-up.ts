// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Brings a server's compute up and boots it, as provision, start and restart do. A first start
 * with no room falls back to another runtime here, as does a new server that can't come up where
 * it is, and a start onto a change that rewrites the world goes the way an update does, with a
 * snapshot to go back to; one refused where it is goes the way `host-refused.ts` takes it.
 * Updating a running server is `updating.ts`; waking a resting world is `stored-worlds.ts`.
 */
import type { AppliedConfigJson, Db } from '@blockly/db'
import { rewritesWorld } from '../../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { aside, inFull, PermanentFailure } from '../../errors.ts'
import type { AccessPolicy } from '../../policy/access-policy.ts'
import { RuntimeFull, type RuntimeHandle, type RuntimeSpec, runtimeKey } from '../../ports/runtime.ts'
import { runsOf } from '../../revisions/caps.ts'
import { switchNeverBooted, switchUnstarted } from '../../runtimes/persistence.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import type { RuntimePlacement } from '../../runtimes/service.ts'
import { heldStorage } from '../../servers/kept-storage.ts'
import { loadRevision, lockServer, type RuntimeBinding, saveHandle } from '../../servers/persistence.ts'
import type { DesiredRuntime, RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { clearPresence, closeInterval, openInterval } from '../../servers/usage.ts'
import { enqueuePrune } from '../../worlds/service.ts'
import { type BootSequence, notUpHere } from '../boot.ts'
import {
  NoLongerApplies,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
  type OperationStep,
} from '../runner.ts'
import { appliedConfig, type ServerBinding } from './binding.ts'
import type { GameConsole } from './game-console.ts'
import type { GoingBack } from './going-back.ts'
import { hostRefused } from './host-refused.ts'
import type { Rechecks } from './rechecks.ts'
import type { WorldCopies } from './world-copies.ts'

/** What `requestedBy()` writes for a start a connection asked for (`system:wake`). */
export const WOKEN_BY = 'system:wake'

/**
 * What a server runs once its start `reached` a resume: what it booted with, even where `desired`
 * differs in what only a start reads (`resumesOn`). Its digest stays that one's, so its next boot
 * puts the change in place, as a change taken live keeps it (`takeLive`).
 */
const asItSlept = (
  desired: DesiredRuntime,
  applied: AppliedConfigJson | null,
  reached: OperationStep | null,
): DesiredRuntime =>
  reached === 'resuming' && applied !== null && applied.specDigest !== desired.digest
    ? { ...desired, digest: applied.specDigest }
    : desired

/** What a server's start onto another runtime reads and writes. */
interface OtherRuntimes {
  db: Db
  runtime: Pick<Runtimes, 'destroy'>
  placement: Pick<RuntimePlacement, 'fallbackFor' | 'fellBack' | 'nextFor'>
}

/**
 * The explicit fallback (docs/runtimes.md): a server that has never started, whose runtime had
 * no room, starts on the one placement falls back to instead, and stays there. Only a binding
 * that still holds nothing moves so, and the move is recorded; what the first runtime may have
 * begun for it is cleared. Null when there is nowhere to fall back to.
 */
async function fallBack(
  { db, runtime, placement }: OtherRuntimes,
  server: MinecraftServer,
  binding: RuntimeBinding,
  error: unknown,
): Promise<string | null> {
  if (!(error instanceof RuntimeFull) || binding.handle !== null || binding.applied !== null) return null
  const to = await placement.fallbackFor(server.id, binding.provider)
  if (to === null) return null
  const switched = await db.transaction(async (tx) => {
    if (!(await switchUnstarted(tx, server.id, binding.provider, to))) return false
    await placement.fellBack(tx, server.id, binding.provider, to, error.message)
    return true
  })
  if (!switched) return null
  await runtime.destroy(binding.provider, runtimeKey(server.id)).catch(() => undefined)
  return to
}

/**
 * A new server whose first start couldn't come up on `from` (it hung, stopped saying nothing
 * recognised, or answered in a way that can't be read) goes to the next runtime with room, once,
 * on record. Its storage holds nothing anyone played: nobody joins a server before it first runs,
 * and only a binding that has never booted moves. Null when there is nowhere to go.
 */
async function moveOn(
  { db, runtime, placement }: OtherRuntimes,
  ctx: OperationContext,
  from: string,
  desired: DesiredRuntime,
  error: unknown,
): Promise<string | null> {
  const server = ctx.server
  const to = await placement.nextFor(server, from, {
    memoryMb: desired.spec.resources.memoryMb,
    storageGb: desired.spec.storage.sizeGb,
  })
  if (to === null) return null
  const switched = await db.transaction(async (tx) => {
    if (!(await switchNeverBooted(tx, server.id, from, to))) return false
    await placement.fellBack(tx, server.id, from, to, inFull(error))
    return true
  })
  if (!switched) return null
  console.warn(
    `operation ${ctx.op.kind} ${ctx.op.id}: didn't come up on ${from}, moving to ${to} (${inFull(error)})`,
  )
  // What still runs there stops with it; one left behind is the orphan sweep's.
  await runtime.destroy(from, runtimeKey(server.id)).catch(() => undefined)
  return to
}

export function bringingUp(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'ensureProvisioned' | 'apply' | 'stop' | 'destroy' | 'hasRoom'>
  placement: Pick<RuntimePlacement, 'fallbackFor' | 'fellBack' | 'nextFor'>
  policy: Pick<AccessPolicy, 'check'>
  specs: Pick<RuntimeSpecs, 'desired'>
  boot: Pick<BootSequence, 'run'>
  transitions: ServerTransitions
  bindingOf: ServerBinding['bindingOf']
  progressSink: ServerBinding['progressSink']
  startCompute: ServerBinding['startCompute']
  booted: ServerBinding['booted']
  stopWhatFailed: ServerBinding['stopWhatFailed']
  stillAllowed: Rechecks['stillAllowed']
  preflight: Rechecks['preflight']
  windDown: GameConsole['windDown']
  capture: WorldCopies['capture']
  rollBack: GoingBack['rollBack']
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
    stillAllowed,
    preflight,
    windDown,
    capture,
    rollBack,
  } = deps

  /**
   * Brings compute up matching the desired spec, then boots. Shared by provision and start;
   * `elsewhere`, a new server that can't come up on its runtime moves to the next (`moveOn`).
   */
  const bringUp = async (
    ctx: OperationContext,
    options: { startAgainOnHang?: boolean; elsewhere?: boolean } = {},
  ): Promise<DesiredRuntime> => {
    const server = ctx.server
    // Provisioning a server whose world rests in the store would give it new, empty storage. Only
    // `unstore` brings such a world back; nothing that reaches here may start it any other way.
    if (server.storedAt !== null)
      throw new PermanentFailure('This server’s world is resting; waking it brings it back.')
    const binding = await bindingOf(server.id)
    let desired = await specs.desired(db, server)
    await preflight(desired, binding.applied)
    let provider = binding.provider
    const provisioned = (spec: RuntimeSpec) =>
      runtime.ensureProvisioned(
        provider,
        runtimeKey(server.id),
        { regionKey: server.regionKey },
        spec,
        progressSink(ctx, server),
        desired.install,
        storage,
      )
    const [askedAt, storage] = [new Date(), await heldStorage(db, server.id, binding.handle)]
    const handle = await provisioned(desired.spec).catch(async (error: unknown) => {
      const fallback = await fallBack(deps, server, binding, error)
      if (fallback === null) throw error
      provider = fallback
      return provisioned(desired.spec)
    })
    desired = asItSlept(desired, binding.applied, ctx.reached())
    // A server that may yet move on is waited on once on each runtime, not twice: two waits in
    // all, inside the half hour the queue gives an operation.
    const elsewhere = options.elsewhere === true && binding.applied === null && runtime.providers.length > 1
    const booting = (started: RuntimeHandle) =>
      // A pack server whose start taught its pack something starts again on what it learned.
      boot.run(
        ctx,
        server,
        started,
        desired.revision,
        async () => {
          desired = await specs.desired(db, server)
          return provisioned(desired.spec)
        },
        { ...(elsewhere ? { startAgainOnHang: false } : options), askedAt },
      )
    await booting(handle).catch(async (error: unknown) => {
      const next = elsewhere && notUpHere(error) ? await moveOn(deps, ctx, provider, desired, error) : null
      if (next === null) throw error
      provider = next
      await booting(await provisioned(desired.spec))
    })
    return desired
  }

  const provision: OperationHandler = {
    kind: 'provision',
    phase: 'provisioning',
    runsWhen: ['provisioning'],
    abandon: stopWhatFailed(['provisioning']),
    async run(ctx) {
      const decision = await stillAllowed(ctx.server, 'continue_provisioning')
      if (!decision.ok) throw new PermanentFailure(decision.message)
      const desired = await bringUp(ctx, { elsewhere: true })
      await db.transaction(async (tx) => {
        const server = await lockServer(tx, ctx.server.id)
        // Deleted while it was being built: the queued decommission cleans up after us.
        if (server === null || server.lifecycle.status !== 'provisioning') return
        await booted(tx, server.id, appliedConfig(server, desired))
        await openInterval(tx, server.id, server.memoryTier, new Date())
        await transitions.outcome(tx, server, { type: 'provisioned' })
      })
      return { status: 'succeeded' }
    },
  }

  /**
   * A change made while the server was stopped that rewrites what is on its storage: another pack,
   * another Minecraft, another server type. Null when the start boots what the server ran before,
   * or when it never ran.
   */
  const pendingInstall = async (server: MinecraftServer) => {
    if (server.storedAt !== null) return null
    const binding = await bindingOf(server.id)
    const previous = binding.applied
    if (binding.handle === null || previous === null) return null
    const desired = await specs.desired(db, server)
    if (previous.specDigest === desired.digest) return null
    const ran = await loadRevision(db, previous.revisionId)
    return rewritesWorld(ran, desired.revision) ? { handle: binding.handle, previous, desired } : null
  }

  /**
   * Starts a server onto a change that rewrites its storage the way an update of a running one
   * goes (§9): a snapshot first, then the new configuration, and if it doesn't come up, the
   * snapshot and the configuration before it back, running, since a start was asked for.
   */
  const installOnStart = async (
    ctx: OperationContext,
    installing: { handle: RuntimeHandle; previous: AppliedConfigJson; desired: DesiredRuntime },
  ): Promise<DesiredRuntime | OperationResult> => {
    const server = ctx.server
    await preflight(installing.desired, installing.previous)
    await ctx.step('saving')
    const snapshot = await capture(server, installing.handle, installing.previous, 'pre_apply', false)
    try {
      // Its rollback starts it fresh on what ran before, so this boot doesn't start it again itself.
      return await bringUp(ctx, { startAgainOnHang: false })
    } catch (error) {
      // A server sent to the trash meanwhile has nothing to go back to.
      if (error instanceof NoLongerApplies) throw error
      await ctx.step('rolling_back')
      try {
        await rollBack(ctx, server, installing.previous, installing.desired, snapshot, 'starting')
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
  }

  const start: OperationHandler = {
    kind: 'start',
    phase: 'starting',
    runsWhen: ['starting'],
    abandon: stopWhatFailed(['starting']),
    async run(ctx) {
      const decision = await stillAllowed(ctx.server, 'continue_starting')
      if (!decision.ok) {
        await db.transaction(async (tx) => {
          const server = await lockServer(tx, ctx.server.id)
          if (server?.lifecycle.status === 'starting')
            await transitions.outcome(tx, server, { type: 'refused', reason: 'policy' })
        })
        return { status: 'cancelled', reason: decision.message }
      }
      const installing = await pendingInstall(ctx.server)
      let desired: DesiredRuntime
      try {
        if (installing === null) desired = await bringUp(ctx)
        else {
          const installed = await installOnStart(ctx, installing)
          if ('status' in installed) return installed
          desired = installed
        }
      } catch (error) {
        return await hostRefused(deps).refusedHere(ctx, error)
      }
      await db.transaction(async (tx) => {
        const server = await lockServer(tx, ctx.server.id)
        if (server === null || server.lifecycle.status !== 'starting') return
        await booted(tx, server.id, appliedConfig(server, desired))
        // A run nobody asked for in the app is one a connection woke; it runs on probation.
        await openInterval(tx, server.id, server.memoryTier, new Date(), ctx.op)
        const started = await transitions.outcome(tx, server, { type: 'started' })
        await enqueuePrune(tx, transitions, started)
      })
      return { status: 'succeeded' }
    },
  }

  /**
   * Stop, then start (§9, §10). The stop half winds the server down as a stop does. `stopping`
   * holds compute, so the server keeps its running slot throughout; before the start half boots it
   * again, on what it should run, the restart is checked again, since switches, standing and the
   * month's hours may have changed since it was asked for.
   */
  const restart: OperationHandler = {
    kind: 'restart',
    phase: 'starting',
    failsFrom: ['stopping', 'starting'],
    runsWhen: ['stopping', 'starting'],
    abandon: stopWhatFailed(['stopping', 'starting']),
    async run(ctx) {
      const server = ctx.server
      const binding = await bindingOf(server.id)
      if (server.lifecycle.status === 'stopping') {
        if (binding.handle !== null) {
          await ctx.step('saving')
          await windDown(server, binding.handle)
          await ctx.step('stopping')
          await runtime.stop(binding.handle)
        }
        const decision = await db.transaction(async (tx) => {
          const locked = await lockServer(tx, server.id)
          if (locked?.lifecycle.status !== 'stopping') return null
          await closeInterval(tx, server.id, new Date())
          const decision = await deps.policy.check(tx, locked.ownerId, {
            kind: 'restart_server',
            runs: runsOf(locked.memoryTier, await loadRevision(tx, locked.desiredRevisionId)),
          })
          if (decision.ok) await transitions.outcome(tx, locked, { type: 'restarting' })
          else {
            await clearPresence(tx, server.id)
            await transitions.outcome(tx, locked, { type: 'stopped', reason: 'policy' })
          }
          return decision
        })
        if (decision === null)
          return { status: 'cancelled', reason: 'The server changed during the restart.' }
        if (!decision.ok) return { status: 'cancelled', reason: decision.message }
      }
      let desired = await specs.desired(db, server)
      await preflight(desired, binding.handle === null ? null : binding.applied)
      let handle = binding.handle
      if (handle === null) {
        handle = await runtime.ensureProvisioned(
          binding.provider,
          runtimeKey(server.id),
          { regionKey: server.regionKey },
          desired.spec,
          progressSink(ctx, server),
          desired.install,
        )
      } else {
        if (binding.applied?.specDigest !== desired.digest) {
          handle = await runtime.apply(handle, desired.spec)
          await saveHandle(db, server.id, handle)
        }
        handle = await startCompute(server.id, handle)
      }
      const started = handle
      await boot.run(ctx, server, started, desired.revision, async () => {
        desired = await specs.desired(db, server)
        const next = await runtime.apply(started, desired.spec)
        await saveHandle(db, server.id, next)
        return startCompute(server.id, next)
      })
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'starting') return
        await booted(tx, server.id, appliedConfig(locked, desired))
        await openInterval(tx, server.id, locked.memoryTier, new Date())
        const started = await transitions.outcome(tx, locked, { type: 'started' })
        await enqueuePrune(tx, transitions, started)
      })
      return { status: 'succeeded' }
    },
  }

  return { provision, start, restart }
}
