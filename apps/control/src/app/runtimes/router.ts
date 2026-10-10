// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConsoleTarget, ReadinessProbe, ServerConsole, ServerStatusPing } from '../ports/minecraft.ts'
import type { LogLine, LogSource } from '../ports/platform.ts'
import {
  type ArchiveTarget,
  type Audience,
  type Endpoint,
  type ExecResult,
  type InstallSeed,
  type MinecraftRuntime,
  type Placement,
  type ProgressSink,
  type RestoreSource,
  type RuntimeCapacity,
  type RuntimeHandle,
  type RuntimeKey,
  type RuntimeLocation,
  type RuntimeObservation,
  type RuntimePrices,
  type RuntimeSpec,
  type RuntimeTags,
  RuntimeUnsupported,
  type SnapshotHandle,
} from '../ports/runtime.ts'

/** What is done through a handle: the port's own verbs, each sent to the runtime that issued it. */
type HandleVerbs =
  | 'apply'
  | 'start'
  | 'restart'
  | 'stop'
  | 'forceStop'
  | 'waitRunning'
  | 'snapshot'
  | 'goneSnapshots'
  | 'deleteSnapshot'
  | 'restore'
  | 'relocate'
  | 'exportSnapshot'
  | 'exec'
  | 'decommission'
  | 'release'
  | 'observe'
  | 'observeChanged'
  | 'isPlaced'
  | 'sameCompute'
  | 'inventory'
  | 'endpoint'
  | 'tag'
  | 'locate'
  | 'prices'

/**
 * Every runtime a deployment runs, as one (docs/runtimes.md). A server's handle says which runtime
 * issued it, and that runtime is the only one ever handed it: a server on Fly stays on Fly, one on
 * the fleet stays on the fleet, whatever new servers are sent to. Only what has no handle yet names
 * its runtime itself: a first provisioning, an adoption, a destroy by key, each with the provider
 * its binding records. Nothing here chooses where a server goes; that is placement's
 * (`placement.ts`), decided once when a server is made and recorded.
 */
export interface Runtimes extends Pick<MinecraftRuntime, HandleVerbs> {
  /** The provider ids this deployment runs, in the order configured. */
  readonly providers: readonly string[]
  /** Whether this deployment runs `provider`: a binding to any other is foreign here. */
  runs(provider: string): boolean
  /** The provider of the runtime that issued `handle`; null when none here did. */
  providerOf(handle: RuntimeHandle): string | null
  /**
   * The most servers the deployment can hold, counting what each needs at its busiest: the sum of
   * its runtimes' ceilings, or null where any runtime has none.
   */
  readonly serverCeiling: number | null
  /** One runtime's own ceiling, as `MinecraftRuntime.serverCeiling`. */
  ceilingOf(provider: string): number | null
  /** How long the runtime that took `snapshot` keeps it; null when it keeps it until deleted. */
  snapshotLifetimeDays(snapshot: SnapshotHandle): number | null

  hasRoom(
    provider: string,
    placement: Placement,
    size: { memoryMb: number; storageGb: number },
  ): Promise<boolean>
  ensureProvisioned(
    provider: string,
    key: RuntimeKey,
    placement: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    install?: InstallSeed | null,
  ): Promise<RuntimeHandle>
  adopt(provider: string, key: RuntimeKey, placement: Placement, spec: RuntimeSpec): Promise<RuntimeHandle>
  destroy(provider: string, target: RuntimeKey | RuntimeHandle): Promise<void>

  /**
   * Whether a stopped server's endpoint still reaches it and nothing else, on the runtime that
   * issued the handle (`MinecraftRuntime.stableEndpoints`): one deployment may mix runtimes whose
   * addresses stay with ones whose addresses move.
   */
  stableEndpoint(handle: RuntimeHandle): boolean
  /** What one runtime's own machines cost and hold; null where only its servers are billed. */
  capacity(provider: string): Promise<RuntimeCapacity | null>
}

/** Several listings read as one: every part is yielded, and a part that failed is thrown at the end. */
async function* merged<T>(parts: ReadonlyArray<() => AsyncIterable<T>>): AsyncIterable<T> {
  const failures: unknown[] = []
  for (const part of parts) {
    try {
      for await (const item of part()) yield item
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Some runtimes could not be listed')
}

export class RuntimeRouter implements Runtimes {
  readonly providers: readonly string[]
  readonly #members: ReadonlyMap<string, MinecraftRuntime>

  constructor(members: readonly MinecraftRuntime[]) {
    if (members.length === 0) throw new Error('A deployment runs at least one runtime')
    const byProvider = new Map<string, MinecraftRuntime>()
    for (const member of members) {
      if (byProvider.has(member.provider)) throw new Error(`Two runtimes call themselves ${member.provider}`)
      byProvider.set(member.provider, member)
    }
    this.#members = byProvider
    this.providers = [...byProvider.keys()]
  }

  /** The runtime called `provider`; a binding to one this deployment doesn't run never gets here. */
  member(provider: string): MinecraftRuntime {
    const member = this.#members.get(provider)
    if (member === undefined) throw new Error(`This deployment runs no ${provider} runtime`)
    return member
  }

  runs(provider: string): boolean {
    return this.#members.has(provider)
  }

  providerOf(handle: RuntimeHandle): string | null {
    for (const member of this.#members.values()) if (member.owns(handle)) return member.provider
    return null
  }

  #of(handle: RuntimeHandle): MinecraftRuntime {
    for (const member of this.#members.values()) if (member.owns(handle)) return member
    throw new Error('No runtime this deployment runs issued that handle')
  }

  #ofSnapshot(snapshot: SnapshotHandle): MinecraftRuntime | null {
    for (const member of this.#members.values()) if (member.ownsSnapshot(snapshot)) return member
    return null
  }

  get serverCeiling(): number | null {
    let sum = 0
    for (const member of this.#members.values()) {
      if (member.serverCeiling === null) return null
      sum += member.serverCeiling
    }
    return sum
  }

  ceilingOf(provider: string): number | null {
    return this.member(provider).serverCeiling
  }

  snapshotLifetimeDays(snapshot: SnapshotHandle): number | null {
    return this.#ofSnapshot(snapshot)?.snapshotLifetimeDays ?? null
  }

  hasRoom(
    provider: string,
    placement: Placement,
    size: { memoryMb: number; storageGb: number },
  ): Promise<boolean> {
    return this.member(provider).hasRoom(placement, size)
  }

  ensureProvisioned(
    provider: string,
    key: RuntimeKey,
    placement: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    install?: InstallSeed | null,
  ): Promise<RuntimeHandle> {
    return this.member(provider).ensureProvisioned(key, placement, spec, progress, install)
  }

  adopt(provider: string, key: RuntimeKey, placement: Placement, spec: RuntimeSpec): Promise<RuntimeHandle> {
    return this.member(provider).adopt(key, placement, spec)
  }

  destroy(provider: string, target: RuntimeKey | RuntimeHandle): Promise<void> {
    return this.member(provider).destroy(target)
  }

  apply(handle: RuntimeHandle, spec: RuntimeSpec): Promise<RuntimeHandle> {
    return this.#of(handle).apply(handle, spec)
  }

  start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    return this.#of(handle).start(handle)
  }

  restart(handle: RuntimeHandle): Promise<void> {
    return this.#of(handle).restart(handle)
  }

  stop(handle: RuntimeHandle): Promise<void> {
    return this.#of(handle).stop(handle)
  }

  forceStop(handle: RuntimeHandle): Promise<void> {
    return this.#of(handle).forceStop(handle)
  }

  waitRunning(handle: RuntimeHandle, signal: AbortSignal): Promise<void> {
    return this.#of(handle).waitRunning(handle, signal)
  }

  snapshot(handle: RuntimeHandle): Promise<{ snapshot: SnapshotHandle; sizeBytes: number; at: Date }> {
    return this.#of(handle).snapshot(handle)
  }

  /** Each runtime answers for its own; one this deployment no longer runs can't say, so none is gone. */
  async goneSnapshots(snapshots: readonly SnapshotHandle[]): Promise<ReadonlySet<SnapshotHandle>> {
    const byMember = new Map<MinecraftRuntime, SnapshotHandle[]>()
    for (const snapshot of snapshots) {
      const member = this.#ofSnapshot(snapshot)
      if (member === null) continue
      byMember.set(member, [...(byMember.get(member) ?? []), snapshot])
    }
    const gone = new Set<SnapshotHandle>()
    for (const [member, own] of byMember)
      for (const snapshot of await member.goneSnapshots(own)) gone.add(snapshot)
    return gone
  }

  deleteSnapshot(snapshot: SnapshotHandle): Promise<void> {
    const member = this.#ofSnapshot(snapshot)
    if (member === null)
      return Promise.reject(new RuntimeUnsupported('router', 'deleting a snapshot no runtime here took'))
    return member.deleteSnapshot(snapshot)
  }

  /** A runtime restores its own snapshots and any archive; another's snapshot is never handed to it. */
  restore(
    handle: RuntimeHandle,
    from: RestoreSource,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle> {
    const member = this.#of(handle)
    if (from.kind === 'snapshot' && !member.ownsSnapshot(from.snapshot))
      return Promise.reject(
        new RuntimeUnsupported(member.provider, 'restoring a snapshot another runtime took'),
      )
    return member.restore(handle, from, spec, progress)
  }

  relocate(
    handle: RuntimeHandle,
    to: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    from?: SnapshotHandle,
  ): Promise<RuntimeHandle> {
    const member = this.#of(handle)
    if (from !== undefined && !member.ownsSnapshot(from))
      return Promise.reject(
        new RuntimeUnsupported(member.provider, 'rebuilding from a snapshot another runtime took'),
      )
    return member.relocate(handle, to, spec, progress, from)
  }

  exportSnapshot(
    snapshot: SnapshotHandle,
    target: ArchiveTarget,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const member = this.#ofSnapshot(snapshot)
    if (member === null)
      return Promise.reject(new RuntimeUnsupported('router', 'exporting a snapshot no runtime here took'))
    return member.exportSnapshot(snapshot, target)
  }

  exec(handle: RuntimeHandle, command: readonly string[], timeoutSeconds: number): Promise<ExecResult> {
    return this.#of(handle).exec(handle, command, timeoutSeconds)
  }

  decommission(handle: RuntimeHandle): Promise<void> {
    return this.#of(handle).decommission(handle)
  }

  release(handle: RuntimeHandle): Promise<RuntimeHandle> {
    return this.#of(handle).release(handle)
  }

  observe(handle: RuntimeHandle): Promise<RuntimeObservation> {
    return this.#of(handle).observe(handle)
  }

  observeChanged(
    since: Date,
  ): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle; observation: RuntimeObservation }> {
    return merged([...this.#members.values()].map((member) => () => member.observeChanged(since)))
  }

  isPlaced(handle: RuntimeHandle, placement: Placement): boolean {
    return this.#of(handle).isPlaced(handle, placement)
  }

  /** Compute on two runtimes is never the same compute. */
  sameCompute(a: RuntimeHandle, b: RuntimeHandle): boolean {
    const member = this.#of(a)
    return member.owns(b) && member.sameCompute(a, b)
  }

  inventory(): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle }> {
    return merged([...this.#members.values()].map((member) => () => member.inventory()))
  }

  endpoint(handle: RuntimeHandle, port: string, audience: Audience): Endpoint {
    const member = this.#of(handle)
    return { ...member.endpoint(handle, port, audience), provider: member.provider }
  }

  stableEndpoint(handle: RuntimeHandle): boolean {
    return this.#of(handle).stableEndpoints
  }

  /** Each runtime writes what it holds; one that can't never holds up the others. */
  async tag(servers: ReadonlyMap<RuntimeKey, RuntimeTags>): Promise<number> {
    let written = 0
    const failures: unknown[] = []
    for (const member of this.#members.values()) {
      try {
        written += await member.tag(servers)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Tagged ${written}; some runtimes failed`)
    return written
  }

  locate(handle: RuntimeHandle): RuntimeLocation {
    return this.#of(handle).locate(handle)
  }

  prices(handle: RuntimeHandle, size: { memoryMb: number; storageGb: number }): RuntimePrices | null {
    return this.#of(handle).prices(handle, size)
  }

  capacity(provider: string): Promise<RuntimeCapacity | null> {
    return this.member(provider).capacity()
  }
}

/**
 * The console, readiness probe and output of several runtimes as one. An endpoint carries the
 * runtime that issued it (`Endpoint.provider`, set by the router) and a log is read by handle, so
 * each goes to the adapters its runtime came with. Runtimes that speak Minecraft's own protocols
 * share them; one that reaches its servers another way brings its own.
 */
export interface RuntimeAdapters {
  console: ServerConsole
  probe: ReadinessProbe
  logs: LogSource
}

export class RoutedAdapters {
  readonly console: ServerConsole
  readonly probe: ReadinessProbe
  readonly logs: LogSource

  constructor(router: Runtimes, byProvider: ReadonlyMap<string, RuntimeAdapters>) {
    const first = byProvider.values().next().value
    if (first === undefined) throw new Error('A deployment runs at least one runtime')
    const forEndpoint = (endpoint: Endpoint): RuntimeAdapters =>
      (endpoint.provider === undefined ? undefined : byProvider.get(endpoint.provider)) ?? first
    const forHandle = (handle: RuntimeHandle): RuntimeAdapters => {
      const provider = router.providerOf(handle)
      return (provider === null ? undefined : byProvider.get(provider)) ?? first
    }
    this.console = {
      run: (target: ConsoleTarget, command: string) =>
        forEndpoint(target.endpoint).console.run(target, command),
      runAll: (target: ConsoleTarget, commands: readonly string[]) =>
        forEndpoint(target.endpoint).console.runAll(target, commands),
    }
    this.probe = {
      ping: (endpoint: Endpoint, signal: AbortSignal): Promise<ServerStatusPing> =>
        forEndpoint(endpoint).probe.ping(endpoint, signal),
    }
    this.logs = {
      recent: (handle: RuntimeHandle, limit: number): Promise<LogLine[]> =>
        forHandle(handle).logs.recent(handle, limit),
      tail: (handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<LogLine> =>
        forHandle(handle).logs.tail(handle, signal),
    }
  }
}
