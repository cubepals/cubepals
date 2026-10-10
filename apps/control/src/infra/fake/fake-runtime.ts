// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A provider in memory, for tests and for running the control plane without Docker. It knows
 * nothing about Minecraft: whatever runs is a `FakeWorkload`. Each server's storage is a real
 * directory, so maintenance commands run for real against it, as they would inside a container
 * with the storage mounted. Restore and relocate issue new handles, as Fly does, so callers that
 * keep a stale handle find nothing behind it.
 *
 * The runtime is its boxes, the port's verbs on them, and the switches tests flip to make those
 * verbs fail or wait, which change together. What has a format, a resource or failures of its own
 * and never touches a box is in its parts: the handle strings, the directories on disk, the
 * archive on the wire, the programs it runs, and the hold three verbs share.
 *
 * Parts (`fake-runtime/`):
 * - `archive.ts`: a storage directory to and from an archive store, as a gzipped tar.
 * - `command.ts`: one program run on this computer, for `exec` and for packing archives.
 * - `handle.ts`: the strings it issues as handles and snapshot handles.
 * - `hold.ts`: the next few calls of a verb, held until a test lets them go.
 * - `volumes.ts`: each server's storage and snapshots, as directories under its root.
 */

import type {
  ArchiveTarget,
  Audience,
  Endpoint,
  ExecResult,
  MinecraftRuntime,
  ObservedState,
  Placement,
  ProgressSink,
  RestoreSource,
  RuntimeCapacity,
  RuntimeHandle,
  RuntimeKey,
  RuntimeLocation,
  RuntimeObservation,
  RuntimePrices,
  RuntimeSpec,
  RuntimeTags,
  SnapshotHandle,
} from '../../app/ports/runtime.ts'
import { RuntimeFull, RuntimeUnsupported } from '../../app/ports/runtime.ts'
import { exportArchive, unpackArchive } from './fake-runtime/archive.ts'
import { run } from './fake-runtime/command.ts'
import { FakeHandles } from './fake-runtime/handle.ts'
import { Hold } from './fake-runtime/hold.ts'
import { Volumes } from './fake-runtime/volumes.ts'

export { fakeHandleKey } from './fake-runtime/handle.ts'

/** What runs inside a fake machine. It sees the storage directory and the spec it was started with. */
export interface FakeWorkload {
  /** Throwing fails the start: the machine exits as if it crashed at boot. */
  start(machine: FakeMachine): Promise<void>
  stop(machine: FakeMachine): Promise<void>
}

export interface FakeMachine {
  key: string
  /** The storage directory, standing in for `spec.storage.mountPath`. */
  dir: string
  spec: RuntimeSpec
  /** The host `endpoint` gives for this machine, under every audience. */
  host: string
}

export interface FakeRuntimeOptions {
  /**
   * Its provider id, `fake` by default. Tests that run several runtimes in one deployment give each
   * fake its own, and each issues handles only it owns.
   */
  provider?: string
  deploymentId: string
  /** Where storage directories live. */
  root: string
  /** Product region key → the fake's own region name. */
  regionMap: Readonly<Record<string, string>>
  workload?: FakeWorkload
  /** The most servers the fake provider holds, by a limit of its own; none by default. */
  serverCeiling?: number | null
  /** What it charges, for any size and place; nothing by default. */
  prices?: RuntimePrices | null
  /** Machines it pays for whether servers fill them, as a fleet does; none by default. */
  capacity?: RuntimeCapacity | null
  /**
   * Compute comes back at another edge address each time it starts, and its address is not its
   * own while stopped, as a Boat sandbox's; off by default.
   */
  movingAddresses?: boolean
}

interface Box {
  key: string
  region: string
  generation: number
  dir: string
  spec: RuntimeSpec
  ports: Record<string, number>
  state: 'stopped' | 'running' | 'crashed'
  exit: { code: number; oom: boolean } | null
  compute: boolean
  /** The host it was on is gone: the fake answers as a provider that can't reach it. */
  hostLost: boolean
  /** Its compute and storage were let go (`release`): nothing but its address is left. */
  released: boolean
  changedAt: Date
  snapshots: Map<string, { dir: string; at: Date; sizeBytes: number }>
  /** Generations a restore or move replaced, and when: still listed for a while, as gone. */
  replaced: { generation: number; at: Date }[]
  /** Where the edge reaches it now, with `movingAddresses`: one more each time it moves. */
  address: number
}

const idle: FakeWorkload = { start: async () => {}, stop: async () => {} }

export class FakeRuntime implements MinecraftRuntime {
  readonly provider: string = 'fake'
  readonly stableEndpoints: boolean
  readonly #handles: FakeHandles
  /** Product regions where it has no room, as a test says. */
  readonly #full = new Set<string>()
  /** Regions that fill between a look and a provision: `hasRoom` says yes, provisioning refuses. */
  readonly #fillsOnProvision = new Set<string>()
  readonly serverCeiling: number | null
  readonly snapshotLifetimeDays = null
  readonly #deployment: string
  readonly #root: string
  readonly #volumes: Volumes
  readonly #regions: Record<string, string>
  readonly #workload: FakeWorkload
  readonly #boxes = new Map<string, Box>()
  #bootFailure: (spec: RuntimeSpec) => string | null = () => null
  #exportFailure: { reason: string; unsupported: boolean } | null = null
  /** The most one PUT of an export carries here, under the store's own; a larger archive goes in parts. */
  #maxPutBytes: number | null = null
  #destroyFailure: string | null = null
  #decommissionFailure: string | null = null
  #stopFailure: string | null = null
  /** Why there is no room for compute to come up, as a provider out of capacity or of starts says. */
  #noRoom: string | null = null
  #snapshotFailure: string | null = null
  #releaseFailure: { reason: string; partway: boolean } | null = null
  /** What `du` reports for a server's world, in KB, in place of the real directory's size. */
  readonly #diskUsage = new Map<string, number>()
  #restoreFailure: { reason: string; after: 'storage' | 'compute' } | null = null
  readonly #heldStops = new Hold()
  readonly #heldExports = new Hold()
  readonly #heldReleases = new Hold()
  readonly #prices: RuntimePrices | null
  readonly #capacity: RuntimeCapacity | null
  /** Tags by server, as `tag` last wrote them. */
  readonly #tags = new Map<string, RuntimeTags>()

  constructor(options: FakeRuntimeOptions) {
    if (options.provider !== undefined) this.provider = options.provider
    this.#handles = new FakeHandles(this.provider)
    this.stableEndpoints = !options.movingAddresses
    this.serverCeiling = options.serverCeiling ?? null
    this.#prices = options.prices ?? null
    this.#capacity = options.capacity ?? null
    this.#deployment = options.deploymentId
    this.#root = options.root
    this.#volumes = new Volumes(options.root, options.deploymentId, this.provider)
    this.#regions = { ...options.regionMap }
    this.#workload = options.workload ?? idle
  }

  // ─── The port ──────────────────────────────────────────────────────────────────────────────

  owns(handle: RuntimeHandle): boolean {
    return this.#handles.owns(handle)
  }

  ownsSnapshot(snapshot: SnapshotHandle): boolean {
    return this.#handles.ownsSnapshot(snapshot)
  }

  async hasRoom(placement: Placement): Promise<boolean> {
    return placement.regionKey in this.#regions && !this.#full.has(placement.regionKey)
  }

  /** A box holding nothing, as `release` leaves one: a restore from an archive fills it. */
  async adopt(key: RuntimeKey, placement: Placement, spec: RuntimeSpec): Promise<RuntimeHandle> {
    const region = this.#region(placement)
    const held = this.#boxes.get(key)
    if (held !== undefined) {
      if (!held.released) throw new Error(`The ${this.provider} runtime holds ${key} already`)
      return this.#handle(held)
    }
    const box: Box = {
      key,
      region,
      generation: 1,
      dir: '',
      spec,
      ports: Object.fromEntries(spec.ports.map((p) => [p.name, p.port])),
      state: 'stopped',
      exit: null,
      compute: false,
      hostLost: false,
      released: true,
      changedAt: new Date(),
      snapshots: new Map(),
      replaced: [],
      address: 1,
    }
    this.#boxes.set(key, box)
    return this.#handle(box)
  }

  async ensureProvisioned(
    key: RuntimeKey,
    placement: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle> {
    await progress.step('allocating')
    if (this.#noRoom !== null && this.#boxes.get(key)?.state !== 'running')
      throw new RuntimeFull(this.provider, this.#noRoom)
    const region = this.#region(placement)
    const full = this.#full.has(placement.regionKey) || this.#fillsOnProvision.has(placement.regionKey)
    if (full && !this.#boxes.get(key)?.compute)
      throw new RuntimeFull(this.provider, `no room in ${placement.regionKey}`)
    await progress.step('storage')
    let box = this.#boxes.get(key)
    if (box === undefined) {
      const dir = await this.#volumes.create(key)
      box = {
        key,
        region,
        generation: 1,
        dir,
        spec,
        ports: Object.fromEntries(spec.ports.map((p) => [p.name, p.port])),
        state: 'stopped',
        exit: null,
        compute: false,
        hostLost: false,
        released: false,
        changedAt: new Date(),
        snapshots: new Map(),
        replaced: [],
        address: 1,
      }
      this.#boxes.set(key, box)
    }
    // A provider asked to provision a server whose storage was let go makes new, empty storage,
    // as Fly makes a new volume: the fake does too, so nothing can pass for safe that isn't.
    if (box.released) {
      box.dir = await this.#volumes.create(key)
      box.released = false
    }
    await progress.step('compute')
    box.spec = spec
    box.compute = true
    if (box.state !== 'running' && !this.stableEndpoints) box.address++
    const handle = this.#handle(box)
    await progress.handle(handle)
    if (box.state !== 'running') await this.#start(box)
    return handle
  }

  async apply(handle: RuntimeHandle, spec: RuntimeSpec): Promise<RuntimeHandle> {
    const box = this.#require(handle)
    const running = box.state === 'running'
    if (running) await this.#stop(box)
    box.spec = spec
    box.ports = Object.fromEntries(spec.ports.map((p) => [p.name, p.port]))
    box.compute = true
    if (running) await this.#start(box)
    return this.#handle(box)
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const box = this.#reachable(handle)
    if (!box.compute) throw new Error('This machine was decommissioned; provision it again')
    if (box.state === 'running') return handle
    if (this.#noRoom !== null) throw new RuntimeFull(this.provider, this.#noRoom)
    if (!this.stableEndpoints) box.address++
    await this.#start(box)
    return this.#handle(box)
  }

  async restart(handle: RuntimeHandle): Promise<void> {
    await this.stop(handle).catch(() => this.forceStop(handle))
    await this.start(handle)
  }

  async forceStop(handle: RuntimeHandle): Promise<void> {
    const box = this.#find(handle)
    if (box === null || box.state !== 'running') return
    await this.#workload.stop(this.#machine(box))
    box.state = 'stopped'
    box.exit = { code: 137, oom: false }
    box.changedAt = new Date()
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    if (this.#stopFailure !== null) throw new Error(this.#stopFailure)
    const box = this.#reachable(handle)
    const held = this.#heldStops.take()
    if (held !== null) await held
    if (box.state === 'running') await this.#stop(box)
  }

  async waitRunning(handle: RuntimeHandle, signal: AbortSignal): Promise<void> {
    for (;;) {
      const box = this.#find(handle)
      if (box === null) throw new Error('The machine is gone')
      if (box.state === 'running') return
      if (box.state === 'crashed') throw new Error(`The machine exited with code ${box.exit?.code ?? 1}`)
      if (signal.aborted) throw new Error('The machine did not start in time')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  async snapshot(handle: RuntimeHandle): Promise<{ snapshot: SnapshotHandle; sizeBytes: number; at: Date }> {
    if (this.#snapshotFailure !== null) throw new Error(this.#snapshotFailure)
    const box = this.#reachable(handle)
    const at = new Date()
    const id = `${at.getTime()}-${box.snapshots.size + 1}`
    const { dir, sizeBytes } = await this.#volumes.snapshot(box.key, id, box.dir)
    box.snapshots.set(id, { dir, at, sizeBytes })
    return {
      snapshot: this.#handles.issueSnapshot({ key: box.key, id }),
      sizeBytes,
      at,
    }
  }

  async goneSnapshots(snapshots: readonly SnapshotHandle[]): Promise<ReadonlySet<SnapshotHandle>> {
    return new Set(
      snapshots.filter((snapshot) => {
        if (!this.#handles.ownsSnapshot(snapshot)) return false
        const { key, id } = this.#handles.readSnapshot(snapshot)
        return this.#boxes.get(key)?.snapshots.has(id) !== true
      }),
    )
  }

  async deleteSnapshot(snapshot: SnapshotHandle): Promise<void> {
    const { key, id } = this.#handles.readSnapshot(snapshot)
    const found = this.#boxes.get(key)?.snapshots.get(id)
    if (found === undefined) return
    this.#boxes.get(key)?.snapshots.delete(id)
    await this.#volumes.remove(found.dir)
  }

  /** Fresh storage from a snapshot or an archive, then the power state it had. */
  async restore(
    handle: RuntimeHandle,
    from: RestoreSource,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle> {
    const box = this.#require(handle)
    const running = box.state === 'running'
    if (running) await this.#stop(box)
    await progress.step('storage')
    const dir = await this.#volumes.create(box.key)
    if (from.kind === 'snapshot') await this.#volumes.copy(this.#snapshot(from.snapshot).dir, dir)
    else await unpackArchive(from.download.url, dir)
    if (this.#restoreFailure?.after === 'storage') throw new Error(this.#restoreFailure.reason)
    await progress.step('compute')
    const old = box.dir
    box.dir = dir
    box.spec = spec
    box.replaced.push({ generation: box.generation, at: new Date() })
    box.generation++
    box.compute = true
    box.released = false
    box.changedAt = new Date()
    const next = this.#handle(box)
    await progress.handle(next)
    if (this.#restoreFailure?.after === 'compute') throw new Error(this.#restoreFailure.reason)
    if (old !== '') await this.#volumes.remove(old)
    if (running) await this.#start(box)
    return next
  }

  async relocate(
    handle: RuntimeHandle,
    to: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    from?: SnapshotHandle,
  ): Promise<RuntimeHandle> {
    if (from !== undefined) return this.#rebuild(handle, to, spec, progress, from)
    const box = this.#require(handle)
    const region = this.#region(to)
    const running = box.state === 'running'
    if (running) await this.#stop(box)
    await progress.step('storage')
    box.region = region
    box.spec = spec
    box.replaced.push({ generation: box.generation, at: new Date() })
    box.generation++
    box.changedAt = new Date()
    const next = this.#handle(box)
    await progress.handle(next)
    if (running) await this.#start(box)
    return next
  }

  /**
   * A gzipped tar of the snapshot, uploaded with its length as the Fly and Docker exports do: in
   * one PUT, or in parts when it is larger than one PUT carries (`limitPuts`).
   */
  async exportSnapshot(
    snapshot: SnapshotHandle,
    target: ArchiveTarget,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const failure = this.#exportFailure
    if (failure !== null)
      throw failure.unsupported
        ? new RuntimeUnsupported(this.provider, failure.reason)
        : new Error(failure.reason)
    const held = this.#heldExports.take()
    if (held !== null) await held
    const source = this.#snapshot(snapshot)
    return exportArchive(source.dir, this.#root, target, () => this.#maxPutBytes)
  }

  /**
   * Runs the command on this computer with the storage directory standing in for the mount
   * path, the way the command would see it inside the machine. The machine must be running.
   */
  async exec(handle: RuntimeHandle, command: readonly string[], timeoutSeconds: number): Promise<ExecResult> {
    const box = this.#require(handle)
    if (box.hostLost) throw new Error('The machine’s host is unreachable')
    if (box.state !== 'running') throw new Error('The machine is not running')
    const mount = box.spec.storage.mountPath
    const [program = 'true', ...args] = command.map((part) => rebase(part, mount, box.dir))
    const reported = this.#diskUsage.get(box.key)
    if (program === 'du' && reported !== undefined)
      return { exitCode: 0, stdout: `${reported}\t${mount}\n`, stderr: '' }
    return run(program, args, timeoutSeconds * 1000, { tolerateFailure: true })
  }

  async decommission(handle: RuntimeHandle): Promise<void> {
    if (this.#decommissionFailure !== null) throw new Error(this.#decommissionFailure)
    const box = this.#find(handle)
    if (box === null) return
    if (box.state === 'running') await this.#stop(box)
    box.compute = false
    box.changedAt = new Date()
  }

  /** Compute stops and goes, then storage and its snapshots; the box stays, as Fly keeps the app. */
  async release(handle: RuntimeHandle): Promise<RuntimeHandle> {
    // By the server's key, not the exact handle: a release asked again after the first one went
    // through, before anyone kept its new handle, finds nothing more to do.
    const { key, deployment } = this.#handles.read(handle)
    if (deployment !== this.#deployment) throw new Error('This handle belongs to another deployment')
    const box = this.#boxes.get(key)
    if (box === undefined) throw new Error('No machine answers to this handle any more')
    if (box.released) return this.#handle(box)
    const held = this.#heldReleases.take()
    if (held !== null) await held
    if (box.state === 'running') await this.#stop(box)
    box.compute = false
    box.changedAt = new Date()
    if (this.#releaseFailure !== null) {
      if (!this.#releaseFailure.partway) box.compute = true
      throw new Error(this.#releaseFailure.reason)
    }
    for (const snapshot of box.snapshots.values()) await this.#volumes.remove(snapshot.dir)
    box.snapshots.clear()
    if (box.dir !== '') await this.#volumes.remove(box.dir)
    box.dir = ''
    box.released = true
    box.replaced.push({ generation: box.generation, at: new Date() })
    box.generation++
    return this.#handle(box)
  }

  async destroy(target: RuntimeKey | RuntimeHandle): Promise<void> {
    if (this.#destroyFailure !== null) throw new Error(this.#destroyFailure)
    const key = this.owns(target as RuntimeHandle) ? this.#handles.read(target).key : target
    const box = this.#boxes.get(key)
    if (box === undefined) return
    if (box.state === 'running') await this.#stop(box)
    this.#boxes.delete(key)
    await this.#volumes.removeAll(key)
  }

  async observe(handle: RuntimeHandle): Promise<RuntimeObservation> {
    const box = this.#find(handle)
    if (box === null || !box.compute) return { state: 'absent', at: new Date() }
    if (this.stableEndpoints || this.#handles.read(handle).address === box.address)
      return this.#observation(box)
    return { ...this.#observation(box), handle: this.#handle(box) }
  }

  async *observeChanged(
    since: Date,
  ): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle; observation: RuntimeObservation }> {
    for (const box of this.#boxes.values()) {
      if (box.changedAt >= since)
        yield {
          key: box.key as RuntimeKey,
          handle: this.#handle(box),
          observation: box.compute ? this.#observation(box) : { state: 'absent' as const, at: box.changedAt },
        }
      // What a restore or move replaced is listed too, gone, as Fly lists destroyed machines.
      for (const { generation, at } of box.replaced)
        if (at >= since)
          yield {
            key: box.key as RuntimeKey,
            handle: this.#handle({ ...box, generation }),
            observation: { state: 'absent' as const, at },
          }
    }
  }

  isPlaced(handle: RuntimeHandle, placement: Placement): boolean {
    const box = this.#find(handle)
    return box !== null && box.region === this.#regions[placement.regionKey]
  }

  sameCompute(a: RuntimeHandle, b: RuntimeHandle): boolean {
    const [first, second] = [this.#handles.read(a), this.#handles.read(b)]
    return first.key === second.key && first.generation === second.generation
  }

  async *inventory(): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle }> {
    for (const box of this.#boxes.values()) yield { key: box.key as RuntimeKey, handle: this.#handle(box) }
  }

  endpoint(handle: RuntimeHandle, port: string, audience: Audience): Endpoint {
    const { key } = this.#handles.read(handle)
    const box = this.#boxes.get(key)
    const number = box?.ports[port]
    if (number === undefined) throw new Error(`This runtime exposes no port named ${port}`)
    // The edge follows compute where it moves; the fake's own console finds it by its name.
    const { address } = this.#handles.read(handle)
    if (audience === 'edge' && address !== undefined)
      return { host: `a${address}.${hostOf(key)}`, port: number }
    return { host: hostOf(key), port: number }
  }

  /** Held by compute, as a provider's machine holds them; a server with none has nowhere for them. */
  async tag(servers: ReadonlyMap<RuntimeKey, RuntimeTags>): Promise<number> {
    let written = 0
    for (const [key, tags] of servers) {
      if (!this.#boxes.get(key)?.compute) continue
      if (JSON.stringify(this.#tags.get(key) ?? {}) === JSON.stringify(tags)) continue
      this.#tags.set(key, { ...tags })
      written++
    }
    return written
  }

  locate(handle: RuntimeHandle): RuntimeLocation {
    const { key, generation } = this.#handles.read(handle)
    return { names: [{ label: 'Machine', value: `${key}/${generation}` }], link: null }
  }

  prices(): RuntimePrices | null {
    return this.#prices
  }

  async capacity(): Promise<RuntimeCapacity | null> {
    return this.#capacity
  }

  // ─── What tests and the fake workload reach for ────────────────────────────────────────────

  tagsOf(key: string): RuntimeTags | null {
    return this.#tags.get(key) ?? null
  }

  /** The machine behind a host `endpoint` gave out, while it runs. */
  machineAt(host: string): (FakeMachine & { running: boolean }) | null {
    for (const box of this.#boxes.values())
      if (hostOf(box.key) === host) return { ...this.#machine(box), running: box.state === 'running' }
    return null
  }

  machine(
    key: string,
  ): (FakeMachine & { state: Box['state']; region: string; compute: boolean; released: boolean }) | null {
    const box = this.#boxes.get(key)
    return box === undefined
      ? null
      : {
          ...this.#machine(box),
          state: box.state,
          region: box.region,
          compute: box.compute,
          released: box.released,
        }
  }

  /** No room in a product region from now on, or again room with `false`, as a full provider. */
  fill(regionKey: string, full = true): void {
    if (full) this.#full.add(regionKey)
    else this.#full.delete(regionKey)
  }

  /** The region fills between a look and a provision, as when another server took the last room. */
  fillOnProvision(regionKey: string, full = true): void {
    if (full) this.#fillsOnProvision.add(regionKey)
    else this.#fillsOnProvision.delete(regionKey)
  }

  /** The host under the machine fails: the workload is gone, and the provider can't reach it. */
  async loseHost(key: string): Promise<void> {
    const box = this.#boxes.get(key)
    if (box === undefined) throw new Error(`No machine for ${key}`)
    if (box.state === 'running') await this.#workload.stop(this.#machine(box))
    box.hostLost = true
    box.changedAt = new Date()
  }

  /**
   * The host comes back, as after a network blip: the provider reaches the machine again, and a
   * workload that was running runs again on the storage it had.
   */
  async regainHost(key: string): Promise<void> {
    const box = this.#boxes.get(key)
    if (box === undefined) throw new Error(`No machine for ${key}`)
    box.hostLost = false
    if (box.state === 'running') await this.#start(box)
    box.changedAt = new Date()
  }

  /** A product region mapped onto another fake region, as after the old one was deprecated. */
  remap(regionKey: string, region: string): void {
    this.#regions[regionKey] = region
  }

  /** The provider brings a server's compute back at another address, without being asked. */
  move(key: string): void {
    const box = this.#boxes.get(key)
    if (box === undefined) throw new Error(`No fake machine for ${key}`)
    box.address++
    box.changedAt = new Date()
  }

  /** The workload dies on its own: a crash, or the kernel's OOM killer. */
  crash(key: string, exit: { code: number; oom: boolean } = { code: 1, oom: false }): void {
    const box = this.#boxes.get(key)
    if (box === undefined) throw new Error(`No machine for ${key}`)
    box.state = 'crashed'
    box.exit = exit
    box.changedAt = new Date()
  }

  /** Starts fail with this message for every spec it returns one for. */
  failBootWhen(reason: (spec: RuntimeSpec) => string | null): void {
    this.#bootFailure = reason
  }

  /**
   * The next `count` stops hang, as a provider call that never answers does, until the returned
   * function lets them go.
   */
  holdStops(count: number): () => void {
    return this.#heldStops.hold(count)
  }

  /** The next `count` exports wait, as a long upload does, until the returned function lets them go. */
  holdExports(count: number): () => void {
    return this.#heldExports.hold(count)
  }

  /** The next `count` releases wait, mid-rest, until the returned function lets them go. */
  holdReleases(count: number): () => void {
    return this.#heldReleases.hold(count)
  }

  /** Every destroy fails with this message, until it is set back to null. */
  failDestroys(reason: string | null): void {
    this.#destroyFailure = reason
  }

  /** Every snapshot fails with this message, until it is set back to null. */
  failSnapshots(reason: string | null): void {
    this.#snapshotFailure = reason
  }

  /** Nothing stopped comes up, for want of room, until it is set back to null. */
  full(detail: string | null): void {
    this.#noRoom = detail
  }

  /** Every graceful stop fails with this message, until it is set back to null. */
  failStops(reason: string | null): void {
    this.#stopFailure = reason
  }

  /** Every decommission fails with this message, until it is set back to null. */
  failDecommissions(reason: string | null): void {
    this.#decommissionFailure = reason
  }

  /** Exports larger than this go in parts, until it is set back to null (the store's own limit). */
  limitPuts(bytes: number | null): void {
    this.#maxPutBytes = bytes
  }

  /**
   * Every export fails with this message, until it is set back to null; `unsupported`, as one no
   * retry changes (a world too big to pack).
   */
  failExports(reason: string | null, { unsupported = false }: { unsupported?: boolean } = {}): void {
    this.#exportFailure = reason === null ? null : { reason, unsupported }
  }

  /**
   * Every release fails with this message, until it is set back to null: at once, or `partway`,
   * with the compute already gone and the storage still there.
   */
  /** A world as big as a test needs it, without writing gigabytes: what `du` says, in KB; null: the real size. */
  reportDiskUsage(key: string, kilobytes: number | null): void {
    if (kilobytes === null) this.#diskUsage.delete(key)
    else this.#diskUsage.set(key, kilobytes)
  }

  failReleases(reason: string | null, options: { partway?: boolean } = {}): void {
    this.#releaseFailure = reason === null ? null : { reason, partway: options.partway === true }
  }

  /**
   * Every restore fails with this message, until it is set back to null: once the new storage is
   * filled but before anything uses it, or once the new compute is on it.
   */
  failRestores(reason: string | null, after: 'storage' | 'compute' = 'storage'): void {
    this.#restoreFailure = reason === null ? null : { reason, after }
  }

  // ─── Inside ────────────────────────────────────────────────────────────────────────────────

  async #start(box: Box): Promise<void> {
    box.changedAt = new Date()
    const failure = this.#bootFailure(box.spec)
    if (failure !== null) {
      box.state = 'crashed'
      box.exit = { code: 1, oom: false }
      return
    }
    try {
      await this.#workload.start(this.#machine(box))
      box.state = 'running'
      box.exit = null
    } catch {
      box.state = 'crashed'
      box.exit = { code: 1, oom: false }
    }
  }

  async #stop(box: Box): Promise<void> {
    await this.#workload.stop(this.#machine(box))
    box.state = 'stopped'
    box.exit = { code: 0, oom: false }
    box.changedAt = new Date()
  }

  #observation(box: Box): RuntimeObservation {
    if (box.hostLost) return { state: 'unknown', at: box.changedAt, hostLost: true }
    const state: ObservedState = box.state
    return { state, at: box.changedAt, ...(box.exit && box.state === 'crashed' ? { exit: box.exit } : {}) }
  }

  /** The machine a handle names, when its host can be reached. */
  #reachable(handle: RuntimeHandle): Box {
    const box = this.#require(handle)
    if (box.hostLost) throw new Error('The machine’s host is unreachable')
    return box
  }

  /** New storage from a snapshot, somewhere the lost host isn't; the old volume stays with it. */
  async #rebuild(
    handle: RuntimeHandle,
    to: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    from: SnapshotHandle,
  ): Promise<RuntimeHandle> {
    const box = this.#require(handle)
    const region = this.#region(to)
    await progress.step('storage')
    const dir = await this.#volumes.create(box.key)
    await this.#volumes.copy(this.#snapshot(from).dir, dir)
    await progress.step('compute')
    box.replaced.push({ generation: box.generation, at: new Date() })
    box.dir = dir
    box.region = region
    box.spec = spec
    box.generation++
    box.hostLost = false
    box.state = 'stopped'
    box.exit = null
    box.compute = true
    box.changedAt = new Date()
    const next = this.#handle(box)
    await progress.handle(next)
    return next
  }

  #machine(box: Box): FakeMachine {
    return { key: box.key, dir: box.dir, spec: box.spec, host: hostOf(box.key) }
  }

  #region(placement: Placement): string {
    const region = this.#regions[placement.regionKey]
    if (region === undefined) throw new Error(`Region ${placement.regionKey} has no fake placement`)
    return region
  }

  #handle(box: Box): RuntimeHandle {
    const ref = { deployment: this.#deployment, key: box.key, generation: box.generation }
    return this.#handles.issue(this.stableEndpoints ? ref : { ...ref, address: box.address })
  }

  /** The machine a handle names, or null when the handle is stale or its machine is gone. */
  #find(handle: RuntimeHandle): Box | null {
    const ref = this.#handles.read(handle)
    if (ref.deployment !== this.#deployment) throw new Error('This handle belongs to another deployment')
    const box = this.#boxes.get(ref.key)
    return box !== undefined && box.generation === ref.generation ? box : null
  }

  #require(handle: RuntimeHandle): Box {
    const box = this.#find(handle)
    if (box === null) throw new Error('No machine answers to this handle any more')
    return box
  }

  #snapshot(snapshot: SnapshotHandle): { dir: string; at: Date; sizeBytes: number } {
    const { key, id } = this.#handles.readSnapshot(snapshot)
    const found = this.#boxes.get(key)?.snapshots.get(id)
    if (found === undefined) throw new Error('The snapshot is gone')
    return found
  }
}

const hostOf = (key: string) => `fake-${key.replace(/-/g, '')}`

/** The mount path as a whole path segment, and only that: `/data` but never `/database`. */
function rebase(part: string, mount: string, dir: string): string {
  const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return part.replace(new RegExp(`(^|[\\s'"=;:(])${escaped}(?=$|[/\\s'";:)])`, 'g'), `$1${dir}`)
}
