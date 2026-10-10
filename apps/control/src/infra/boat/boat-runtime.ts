// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Boat sandboxes: one whole Linux VM per server, billed by the second while it runs and free while
 * stopped, running the server's workload as a Docker container (sandbox-scripts.ts). A stopped
 * server's sandbox is stopped, which snapshots its disk at Boat; waking one resumes it, which Boat
 * counts as a machine start (starts.ts), on a new machine at a new IPv6 address. It knows nothing
 * about Minecraft; it runs whatever spec it is given (docs/boat-runtime-plan.md).
 *
 * The runtime is the port's verbs, each an ordering of its parts, and the handles it issues. What
 * has state, failures or a reason to change of its own is in its parts, and none of them knows the
 * port's verbs or reads a handle.
 *
 * Parts (`boat-runtime/`):
 * - `archive-export.ts`: a snapshot's archive, uploaded to the archive store from inside its sandbox.
 * - `commands.ts`: the sandbox's program and other commands, run through Boat's command endpoint.
 * - `observation.ts`: Boat's and Docker's states, read as the port's observed states.
 * - `sandboxes.ts`: this deployment's sandboxes at Boat, through their life from create to delete.
 * - `sizes.ts`: Boat's sandbox sizes, by memory, disk and list price.
 */

import type {
  ArchiveTarget,
  Audience,
  Endpoint,
  ExecResult,
  MinecraftRuntime,
  Placement,
  ProgressSink,
  RestoreSource,
  RuntimeHandle,
  RuntimeKey,
  RuntimeLocation,
  RuntimeObservation,
  RuntimePrices,
  RuntimeSpec,
  RuntimeTags,
  SnapshotHandle,
} from '../../app/ports/runtime.ts'
import { exportArchive } from './boat-runtime/archive-export.ts'
import { neverSaved, SandboxCommands } from './boat-runtime/commands.ts'
import { changedAt, stateOf, UP, workloadObservation } from './boat-runtime/observation.ts'
import { Sandboxes } from './boat-runtime/sandboxes.ts'
import { pricesFor, snapshotRoomBytes, typeOf } from './boat-runtime/sizes.ts'
import type { BoatClient, Sandbox } from './client.ts'
import {
  type BoatRef,
  decodeHandle,
  decodeSnapshot,
  encodeHandle,
  encodeSnapshot,
  isBoatHandle,
  isBoatSnapshot,
} from './handle.ts'
import { inWorkload, quote, WORKLOAD } from './sandbox-scripts.ts'
import type { BoatStarts, StartReason } from './starts.ts'

export { stateOf, workloadObservation } from './boat-runtime/observation.ts'
export { serverOf } from './boat-runtime/sandboxes.ts'
export { typeFor } from './boat-runtime/sizes.ts'

export interface BoatRuntimeOptions {
  client: BoatClient
  deploymentId: string
  starts: BoatStarts
  /** Auto-stop for a sandbox Blockly wants running: none on a paid plan; the trial allows 7200 s at most. */
  runTtlSeconds: number | null
  /**
   * How long a sandbox woken only to work on a stopped server stays up if nothing starts it: Boat
   * stops it then, whatever happened to the work or to this process.
   */
  parkTtlSeconds?: number
  /** Waits; tests pass one that doesn't. */
  pause?: (ms: number) => Promise<void>
  log?: (line: string) => void
  /** The product regions it places servers in, from its region map; every one when absent. */
  regions?: readonly string[]
}

export class BoatRuntime implements MinecraftRuntime {
  readonly provider = 'boat'
  /**
   * Boat caps the sandboxes running at once, not the servers it holds: a stopped sandbox is free
   * and uncounted. The platform's own running cap is what keeps within the plan's.
   */
  readonly serverCeiling = null
  /** Blockly's snapshots are files in the sandbox, kept until deleted. */
  readonly snapshotLifetimeDays = null
  /** A stopped sandbox's address may go to another sandbox, anyone's. */
  readonly stableEndpoints = false
  readonly #deployment: string
  readonly #starts: BoatStarts
  readonly #pause: (ms: number) => Promise<void>
  readonly #log: (line: string) => void
  readonly #sandboxes: Sandboxes
  readonly #commands: SandboxCommands
  readonly #regions: ReadonlySet<string> | null

  constructor(options: BoatRuntimeOptions) {
    this.#deployment = options.deploymentId
    this.#starts = options.starts
    this.#pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#log = options.log ?? ((line) => console.warn(line))
    this.#sandboxes = new Sandboxes({
      client: options.client,
      deploymentId: options.deploymentId,
      starts: options.starts,
      runTtlSeconds: options.runTtlSeconds,
      parkTtlSeconds: options.parkTtlSeconds ?? 600,
      pause: this.#pause,
    })
    this.#commands = new SandboxCommands(options.client, this.#pause)
    this.#regions = options.regions === undefined ? null : new Set(options.regions)
  }

  owns(handle: RuntimeHandle): boolean {
    return isBoatHandle(handle)
  }

  ownsSnapshot(snapshot: SnapshotHandle): boolean {
    return isBoatSnapshot(snapshot)
  }

  /**
   * A region it serves, while the plan has starts to spare beyond those kept for wakes: a new
   * server spends one now and more every time it wakes. Boat's own refusal still comes as
   * RuntimeFull when the room went meanwhile.
   */
  async hasRoom(placement: Placement): Promise<boolean> {
    if (this.#regions !== null && !this.#regions.has(placement.regionKey)) return false
    return this.#starts.headroom()
  }

  /**
   * Nothing is made: a handle with no sandbox, as `release` leaves one, which a restore from an
   * archive fills with a new sandbox, as a wake of a resting server does.
   */
  async adopt(key: RuntimeKey, _placement: Placement, spec: RuntimeSpec): Promise<RuntimeHandle> {
    return encodeHandle({
      deployment: this.#deployment,
      serverId: key,
      sandboxId: null,
      address: null,
      ports: Object.fromEntries(spec.ports.map((p) => [p.name, p.port])),
      open: spec.ports.filter((p) => p.audience.includes('edge') && p.protocol === 'tcp').map((p) => p.port),
      previous: null,
    })
  }

  /** Billed by the second a sandbox runs: no machines of its own to pay for. */
  async capacity(): Promise<null> {
    return null
  }

  async ensureProvisioned(
    key: RuntimeKey,
    _placement: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle> {
    await progress.step('allocating')
    const type = typeOf(spec)
    let sandbox = await this.#sandboxes.ours(key)
    if (sandbox === null) sandbox = await this.#sandboxes.create(key, type, 'provision', null, 'run')
    // The disk comes back with the sandbox: a resume, where one is asleep.
    await progress.step('storage')
    sandbox = await this.#sandboxes.up(key, sandbox, 'provision', 'run', type)
    const handle = this.#handleOf(key, sandbox, spec)
    await progress.handle(handle)
    await progress.step('compute')
    await this.#commands.configure(sandbox.id, key, spec, neverSaved(sandbox))
    await progress.step('booting')
    await this.#commands.run(sandbox.id, 'up', opened(handle))
    return handle
  }

  async apply(handle: RuntimeHandle, spec: RuntimeSpec): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    let found = await this.#sandboxes.get(requireSandbox(ref))
    if (found === null) throw new Error('The sandbox is gone')
    const type = typeOf(spec)
    const running = UP.has(found.state) && (await this.#workloadRunning(found.id))
    // Another size is another machine: a resume onto it, after a stop that saves the world first.
    if (found.type !== type && UP.has(found.state)) {
      await this.#commands.run(found.id, 'stop')
      await this.#sandboxes.stop(found.id)
      found = await this.#sandboxes.get(found.id)
      if (found === null) throw new Error('The sandbox is gone')
    }
    // A stopped server has nowhere to hold a new configuration but its sandbox: it is woken and
    // parked, so Boat stops it again unless a start follows.
    const sandbox = await this.#sandboxes.up(ref.serverId, found, 'apply', running ? 'run' : 'park', type)
    await this.#commands.configure(sandbox.id, ref.serverId, spec)
    const applied = this.#handleOf(ref.serverId, sandbox, spec)
    if (running) await this.#commands.run(sandbox.id, 'up', opened(applied))
    return applied
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    const found = await this.#sandboxes.get(requireSandbox(ref))
    if (found === null) throw new Error('The sandbox is gone')
    const sandbox = await this.#sandboxes.up(ref.serverId, found, 'start', 'run')
    await this.#commands.run(sandbox.id, 'up', opened(handle))
    return this.#moved(ref, sandbox)
  }

  /** The container, not the sandbox: no Boat start, and the address stays. */
  async restart(handle: RuntimeHandle): Promise<void> {
    const ref = decodeHandle(handle)
    await this.#commands.run(requireSandbox(ref), 'restart', opened(handle))
  }

  /**
   * Minecraft first, then the machine: Boat's stop snapshots the disk without telling what runs on
   * it, so the workload stops, bounded by its own stop timeout, and only a sandbox whose workload
   * has stopped is stopped. One that won't stop fails the stop; its operation tries again, and in
   * the end forces it.
   */
  async stop(handle: RuntimeHandle): Promise<void> {
    const ref = decodeHandle(handle)
    if (ref.sandboxId === null) return
    const sandbox = await this.#sandboxes.settled(ref.sandboxId)
    if (sandbox === null || !UP.has(sandbox.state)) return
    const began = Date.now()
    await this.#commands.run(sandbox.id, 'stop')
    const stopped = Date.now()
    await this.#sandboxes.stop(sandbox.id)
    this.#log(
      `boat stop: server=${ref.serverId} sandbox=${sandbox.id} workload=${stopped - began}ms sandbox=${Date.now() - stopped}ms`,
    )
  }

  /** Kills the workload, then stops the sandbox the ordinary way: Boat's forced stop can lose the disk. */
  async forceStop(handle: RuntimeHandle): Promise<void> {
    const ref = decodeHandle(handle)
    if (ref.sandboxId === null) return
    const sandbox = await this.#sandboxes.settled(ref.sandboxId)
    if (sandbox === null || !UP.has(sandbox.state)) return
    await this.#commands.run(sandbox.id, 'kill')
    await this.#sandboxes.stop(sandbox.id)
  }

  async waitRunning(handle: RuntimeHandle, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const seen = await this.observe(handle)
      if (seen.state === 'running') return
      if (seen.state === 'absent') throw new Error('The sandbox is gone')
      if (seen.state === 'crashed' || seen.state === 'stopped')
        throw new Error(`The workload stopped${seen.exit ? ` with code ${seen.exit.code}` : ''}`)
      await this.#pause(1000)
    }
    throw new Error('The workload did not start in time')
  }

  async snapshot(handle: RuntimeHandle) {
    const ref = decodeHandle(handle)
    const sandbox = await this.#awake(ref, 'snapshot')
    const at = new Date()
    const file = `${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tar.gz`
    const keeps = snapshotRoomBytes(sandbox.type)
    const size = await this.#commands.run(sandbox.id, 'snapshot', [file, String(keeps)])
    return {
      snapshot: encodeSnapshot({ sandboxId: sandbox.id, file }),
      sizeBytes: Number(size) || 0,
      at,
    }
  }

  /** One listing per sandbox that is up; a stopped one can't be asked without waking it. */
  async goneSnapshots(snapshots: readonly SnapshotHandle[]): Promise<ReadonlySet<SnapshotHandle>> {
    const bySandbox = new Map<string, SnapshotHandle[]>()
    for (const snapshot of snapshots) {
      if (!isBoatSnapshot(snapshot)) continue
      const { sandboxId } = decodeSnapshot(snapshot)
      bySandbox.set(sandboxId, [...(bySandbox.get(sandboxId) ?? []), snapshot])
    }
    const gone = new Set<SnapshotHandle>()
    for (const [sandboxId, taken] of bySandbox) {
      const sandbox = await this.#sandboxes.get(sandboxId).catch(() => undefined)
      if (sandbox === undefined) continue
      if (sandbox === null) {
        for (const snapshot of taken) gone.add(snapshot)
        continue
      }
      if (!UP.has(sandbox.state)) continue
      const held = await this.#commands.run(sandboxId, 'snapshots').catch(() => null)
      if (held === null) continue
      const files = new Set(held.split(/\s+/).filter(Boolean))
      for (const snapshot of taken) if (!files.has(decodeSnapshot(snapshot).file)) gone.add(snapshot)
    }
    return gone
  }

  async deleteSnapshot(snapshot: SnapshotHandle): Promise<void> {
    const { sandboxId, file } = decodeSnapshot(snapshot)
    const found = await this.#sandboxes.get(sandboxId)
    if (found === null) return
    const key = this.#sandboxes.keyOf(found)
    if (key === null) throw new Error(`${sandboxId} does not belong to deployment ${this.#deployment}`)
    const sandbox = await this.#sandboxes.awake(key, found, 'forget')
    await this.#commands.run(sandbox.id, 'forget', [file])
  }

  /**
   * The world from a snapshot kept in the same sandbox, or from an archive, onto the server's own
   * sandbox; a released server gets a new sandbox first, left parked for the start that follows.
   * The workload is made again from `spec` and left as it was, running or stopped.
   */
  async restore(
    handle: RuntimeHandle,
    from: RestoreSource,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    const snapshot = from.kind === 'snapshot' ? decodeSnapshot(from.snapshot) : null
    if (snapshot !== null && snapshot.sandboxId !== ref.sandboxId)
      throw new Error('That snapshot belongs to another server')
    await progress.step('storage')
    const type = typeOf(spec)
    let found = ref.sandboxId === null ? null : await this.#sandboxes.get(ref.sandboxId)
    if (found === null) {
      if (snapshot !== null) throw new Error('The snapshot went with its sandbox')
      found = await this.#sandboxes.create(
        ref.serverId,
        type,
        'restore',
        ref.sandboxId ?? ref.previous,
        'park',
      )
    }
    const running = UP.has(found.state) && (await this.#workloadRunning(found.id))
    const sandbox = await this.#sandboxes.up(ref.serverId, found, 'restore', running ? 'run' : 'park', type)
    const restored = this.#handleOf(ref.serverId, sandbox, spec)
    await progress.handle(restored)
    // A new sandbox, as a released server gets, has nothing coming back to wait for.
    const isNew = neverSaved(sandbox)
    await this.#commands.run(sandbox.id, 'stop', [], undefined, isNew)
    if (snapshot !== null) await this.#commands.run(sandbox.id, 'restore-snapshot', [snapshot.file])
    else if (from.kind === 'archive')
      await this.#commands.run(sandbox.id, 'restore-archive', [from.download.url], undefined, isNew)
    await progress.step('compute')
    await this.#commands.configure(sandbox.id, ref.serverId, spec, isNew)
    if (running) await this.#commands.run(sandbox.id, 'up', opened(restored))
    return restored
  }

  /** Boat has one place for everything: a move is a no-op, and a rebuild from a snapshot a restore. */
  async relocate(
    handle: RuntimeHandle,
    _to: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    from?: SnapshotHandle,
  ): Promise<RuntimeHandle> {
    if (from === undefined) return handle
    return this.restore(handle, { kind: 'snapshot', snapshot: from }, spec, progress)
  }

  isPlaced(_handle: RuntimeHandle, _placement: Placement): boolean {
    return true
  }

  /**
   * The snapshot's archive, uploaded from inside its sandbox: in one PUT, or, larger than one
   * carries, in parts, their links on the command line, so fewer and larger.
   */
  async exportSnapshot(
    snapshot: SnapshotHandle,
    target: ArchiveTarget,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const { sandboxId, file } = decodeSnapshot(snapshot)
    const found = await this.#sandboxes.get(sandboxId)
    if (found === null) throw new Error('The snapshot went with its sandbox')
    const key = this.#sandboxes.keyOf(found)
    if (key === null) throw new Error(`${sandboxId} does not belong to deployment ${this.#deployment}`)
    const sandbox = await this.#sandboxes.awake(key, found, 'export')
    return exportArchive(this.#commands, sandbox.id, file, target)
  }

  async exec(handle: RuntimeHandle, command: readonly string[], timeoutSeconds: number): Promise<ExecResult> {
    return this.execIn(requireSandbox(decodeHandle(handle)), command, timeoutSeconds)
  }

  /** Not the port's: a command in a sandbox's workload by the sandbox's id, for boat-minecraft.ts. */
  execIn(sandboxId: string, command: readonly string[], timeoutSeconds: number): Promise<ExecResult> {
    return this.#commands.exec(sandboxId, inWorkload(command), timeoutSeconds)
  }

  /**
   * Not the port's: the workload's output with Docker's timestamps, the last `tail` lines or what
   * came after `since`, for boat-minecraft.ts.
   */
  async output(sandboxId: string, options: { tail?: number; since?: string }): Promise<string> {
    const args = ['--timestamps', ...(options.tail === undefined ? [] : ['--tail', String(options.tail)])]
    if (options.since !== undefined) args.push('--since', options.since)
    const read = await this.#commands.exec(
      sandboxId,
      `docker logs ${args.map(quote).join(' ')} ${WORKLOAD} 2>&1`,
      30,
    )
    if (read.exitCode !== 0)
      throw new Error(`Reading the workload's output failed: ${read.stdout.slice(-300)}`)
    return read.stdout
  }

  /** A stopped sandbox is free and keeps the disk: removing compute is stopping it. */
  async decommission(handle: RuntimeHandle): Promise<void> {
    await this.stop(handle)
  }

  /**
   * The sandbox goes, with its disk and Boat's snapshots of it, once the world is safe in the
   * archive store. Anything else named for the server goes too, so what is let go is everything
   * that could bill. The handle keeps the server and names the sandbox it had.
   */
  async release(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    if (ref.deployment !== this.#deployment)
      throw new Error(`${ref.serverId} does not belong to deployment ${this.#deployment}`)
    if (ref.sandboxId !== null) await this.#sandboxes.delete(ref.sandboxId)
    for await (const sandbox of this.#sandboxes.named(ref.serverId as RuntimeKey))
      await this.#sandboxes.delete(sandbox.id)
    return encodeHandle({ ...ref, sandboxId: null, address: null, previous: ref.sandboxId ?? ref.previous })
  }

  async destroy(target: RuntimeKey | RuntimeHandle): Promise<void> {
    const ref = isBoatHandle(target) ? decodeHandle(target) : null
    // Never another deployment's servers, whatever a caller passes.
    if (ref !== null && ref.deployment !== this.#deployment)
      throw new Error(`${ref.serverId} does not belong to deployment ${this.#deployment}`)
    const key = (ref?.serverId ?? target) as RuntimeKey
    if (ref?.sandboxId) {
      const sandbox = await this.#sandboxes.get(ref.sandboxId)
      if (sandbox !== null && this.#sandboxes.keyOf(sandbox) !== key)
        throw new Error(`${sandbox.id} does not belong to deployment ${this.#deployment}`)
      if (sandbox !== null) await this.#sandboxes.delete(sandbox.id)
    }
    for await (const sandbox of this.#sandboxes.named(key)) await this.#sandboxes.delete(sandbox.id)
  }

  async observe(handle: RuntimeHandle): Promise<RuntimeObservation> {
    const ref = decodeHandle(handle)
    const now = new Date()
    if (ref.sandboxId === null) return { state: 'absent', at: now }
    const sandbox = await this.#sandboxes.get(ref.sandboxId).catch(() => undefined)
    if (sandbox === undefined) return { state: 'unknown', at: now }
    if (sandbox === null) return { state: 'absent', at: now }
    if (!UP.has(sandbox.state)) return { state: stateOf(sandbox.state), at: changedAt(sandbox, now) }
    const moved = sandbox.ip && sandbox.ip !== ref.address ? { handle: this.#moved(ref, sandbox) } : {}
    const line = await this.#commands.run(sandbox.id, 'inspect').catch(() => null)
    if (line === null) return { state: 'unknown', at: now, ...moved }
    return { ...workloadObservation(line, now), ...moved }
  }

  /** One listing of the account's sandboxes; running ones read as running until one is asked. */
  async *observeChanged(since: Date) {
    const after = since.getTime() - 60_000
    for await (const sandbox of this.#sandboxes.list()) {
      const key = this.#sandboxes.keyOf(sandbox)
      if (key === null) continue
      const at = changedAt(sandbox, new Date())
      if (at.getTime() < after) continue
      // A sandbox woken only for work on a sleeping server is parked: its workload is stopped and
      // Boat stops it soon by itself. Listed as running, reconcile would stop it as stray, maybe in
      // the middle of that work (a snapshot deleted outside any operation), and the work would wake
      // it again. One that runs and is near its own end is asked about before anything is done.
      const parked = this.#sandboxes.parked(sandbox)
      yield {
        key,
        handle: this.#listed(key, sandbox),
        observation: { state: parked ? ('stopped' as const) : stateOf(sandbox.state), at },
      }
    }
  }

  sameCompute(a: RuntimeHandle, b: RuntimeHandle): boolean {
    const [first, second] = [decodeHandle(a), decodeHandle(b)]
    return first.serverId === second.serverId && first.sandboxId === second.sandboxId
  }

  async *inventory() {
    for await (const sandbox of this.#sandboxes.list()) {
      const key = this.#sandboxes.keyOf(sandbox)
      if (key !== null) yield { key, handle: this.#listed(key, sandbox) }
    }
  }

  /**
   * Pure. The edge reaches the sandbox's address from when the handle was issued, which is only
   * the server's while it runs (`stableEndpoints`); a released server's reaches nothing. The
   * control plane reaches a sandbox through Boat's API, by its id (boat-minecraft.ts).
   */
  endpoint(handle: RuntimeHandle, port: string, audience: Audience): Endpoint {
    const ref = decodeHandle(handle)
    const number = ref.ports[port]
    if (number === undefined) throw new Error(`This runtime exposes no port named ${port}`)
    if (audience === 'control') return { host: ref.sandboxId ?? 'released', port: number }
    return ref.address === null ? { host: '0.0.0.0', port: 0 } : { host: ref.address, port: number }
  }

  /**
   * Written after the sandbox's name, which Boat's dashboard lists, only where it differs. A server
   * with no sandbox has nowhere for them.
   */
  async tag(servers: ReadonlyMap<RuntimeKey, RuntimeTags>): Promise<number> {
    let written = 0
    for await (const sandbox of this.#sandboxes.list()) {
      const key = this.#sandboxes.keyOf(sandbox)
      const tags = key === null ? undefined : servers.get(key)
      if (key === null || tags === undefined) continue
      const words = Object.entries(tags)
        .map(([name, value]) => `${name}=${value}`)
        .join(' ')
      const name = `${this.#sandboxes.nameOf(key)}${words === '' ? '' : ` ${words}`}`.slice(0, 120)
      if (sandbox.name === name) continue
      await this.#sandboxes.rename(sandbox.id, name)
      written++
    }
    return written
  }

  locate(handle: RuntimeHandle): RuntimeLocation {
    const ref = decodeHandle(handle)
    return {
      names: [
        { label: 'Sandbox', value: ref.sandboxId ?? 'none' },
        { label: 'Name', value: this.#sandboxes.nameOf(ref.serverId) },
      ],
      link: 'https://boat.dev/dashboard?tab=sandboxes',
    }
  }

  /** Boat bills a sandbox by its size while it runs, and nothing while it is stopped. */
  prices(_handle: RuntimeHandle, size: { memoryMb: number; storageGb: number }): RuntimePrices | null {
    return pricesFor(size)
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────

  #handleOf(key: string, sandbox: Sandbox, spec: RuntimeSpec): RuntimeHandle {
    return encodeHandle({
      deployment: this.#deployment,
      serverId: key,
      sandboxId: sandbox.id,
      address: sandbox.ip ?? null,
      ports: Object.fromEntries(spec.ports.map((p) => [p.name, p.port])),
      open: spec.ports.filter((p) => p.audience.includes('edge') && p.protocol === 'tcp').map((p) => p.port),
      previous: null,
    })
  }

  /** The handle to keep once the sandbox may be at another address. */
  #moved(ref: BoatRef, sandbox: Sandbox): RuntimeHandle {
    const address = sandbox.ip ?? null
    if (address === ref.address) return encodeHandle(ref)
    this.#log(
      `boat address: server=${ref.serverId} sandbox=${sandbox.id} ${ref.address ?? 'none'} → ${address}`,
    )
    return encodeHandle({ ...ref, address })
  }

  /** What a listing says: the sandbox and where it is, without the ports only the spec knows. */
  #listed(key: RuntimeKey, sandbox: Sandbox): RuntimeHandle {
    return encodeHandle({
      deployment: this.#deployment,
      serverId: key,
      sandboxId: sandbox.id,
      address: sandbox.ip ?? null,
      ports: {},
      open: [],
      previous: null,
    })
  }

  async #workloadRunning(id: string): Promise<boolean> {
    const line = await this.#commands.run(id, 'inspect')
    return /^(running|restarting) /.test(line)
  }

  /** A sandbox that is up, woken and parked for work on a server that is asleep. */
  async #awake(ref: BoatRef, reason: StartReason): Promise<Sandbox> {
    const found = await this.#sandboxes.get(requireSandbox(ref))
    if (found === null) throw new Error('The sandbox is gone')
    return this.#sandboxes.awake(ref.serverId, found, reason)
  }
}

// ─── pure helpers ─────────────────────────────────────────────────────────────────────────────

function requireSandbox(ref: BoatRef): string {
  if (ref.sandboxId === null) throw new Error('This server has no sandbox; its world is resting')
  return ref.sandboxId
}

/** The ports the sandbox's firewall lets in, as the program takes them. */
const opened = (handle: RuntimeHandle) => decodeHandle(handle).open.map(String)
