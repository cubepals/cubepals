/**
 * The provider boundary (docs/architecture.md §7, §8). The application says what a server's
 * workload should be — this spec, running or stopped, in this product region — and a runtime
 * makes that true on its infrastructure. Everything above this file speaks in Minecraft and
 * product terms; everything that implements it (infra/fly, infra/docker, infra/boat,
 * infra/fleet, infra/fake) speaks in containers and volumes and knows nothing about Minecraft.
 *
 * A provider's concepts stay on its side. Handles are opaque: the application stores what an
 * adapter issued and hands it back, and only that adapter reads it. A runtime's `provider` id is
 * recorded beside each handle so no adapter is fed another's, and nothing above this file
 * branches on it (scripts/check-boundaries.ts).
 *
 * A deployment may run several runtimes at once (docs/runtimes.md): the application talks to them
 * as one through app/runtimes/router.ts, which hands each handle to the runtime that `owns` it.
 * Which runtime a new server goes to is a placement decision, made and recorded above the port.
 *
 * Another runtime is an adapter, not a change to the application:
 *  - infra/<name>/: a MinecraftRuntime, and a LogSource (ports/platform.ts) that reads its
 *    handles. The console and readiness are Minecraft's own protocols, spoken to
 *    `endpoint(…, 'control')`, so they ask nothing more of it, unless the network can't reach
 *    its servers: Boat's go through its command endpoint, registered in `RoutedAdapters`.
 *  - A `runtime` variant in config/, and its case in main.node.ts.
 *  - Where its provider can't do something, it says so rather than pretend, in the ways this
 *    port allows: `deleteSnapshot` may throw RuntimeUnsupported, a limit it lacks is null
 *    (`serverCeiling`, `snapshotLifetimeDays`), an InstallSeed may be ignored, and a runtime with
 *    one place makes a move a no-op, a rebuild from a snapshot a restore, and `isPlaced` always
 *    true, as DockerRuntime does. The rest is required.
 *  - The network around it is the deployment's: the edge and the control plane reach what
 *    `endpoint` names, and its workloads reach the artifact endpoint and the archive store.
 */

declare const brand: unique symbol
type Opaque<T, B extends string> = T & { readonly [brand]: B }

/** The platform's stable id for a runtime (the server id). Adapters may embed it in names. */
export type RuntimeKey = Opaque<string, 'RuntimeKey'>
/** Issued by an adapter, stored verbatim, passed back. Changes on restore and relocate. */
export type RuntimeHandle = Opaque<string, 'RuntimeHandle'>
export type SnapshotHandle = Opaque<string, 'SnapshotHandle'>

export const runtimeKey = (serverId: string) => serverId as RuntimeKey

/** A product region key ("eu-central"); the adapter maps it to its own placement. */
export interface Placement {
  regionKey: string
}

export type Audience = 'edge' | 'control'

interface PortSpec {
  name: string
  port: number
  protocol: 'tcp' | 'udp'
  /** Who must be able to reach this port. */
  audience: readonly Audience[]
}

export interface RuntimeSpec {
  image: string
  /** Replaces the image's own entrypoint; absent, the image starts as it was built to. */
  entrypoint?: readonly string[]
  env: Readonly<Record<string, string>>
  secrets: Readonly<Record<string, string>>
  resources: { memoryMb: number }
  storage: {
    mountPath: string
    sizeGb: number
    /**
     * Names at the top of the mount path that the image makes again when they are missing (a
     * server jar and what it unpacks): a runtime moving a server's storage may leave them behind,
     * and the server's next start makes them. Absent or empty, everything is carried.
     */
    reconstructible?: readonly string[]
  }
  ports: readonly PortSpec[]
  stop: { signal: 'SIGTERM' | 'SIGINT'; timeoutSeconds: number }
  labels: Readonly<Record<string, string>>
}

/**
 * A server's install: files the image downloads that are the same for every server with the same
 * `key`. A runtime may make them once, running the spec's image with `env` alone against storage
 * of its own, and copy `paths` into a new server's storage before it first starts, so the image
 * finds them there and downloads nothing. It is never part of what a server is, so no digest sees
 * it, and a runtime that ignores it only makes a first start slower.
 */
export interface InstallSeed {
  key: string
  env: Readonly<Record<string, string>>
  /** Names at the top of the storage's mount path. */
  paths: readonly string[]
}

export interface Endpoint {
  host: string
  port: number
  /**
   * The runtime that issued it, where a deployment runs several: the console and readiness probe
   * that speak to it are that runtime's. Set by the router, never by an adapter.
   */
  provider?: string
}

export type ObservedState = 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'unknown'

export interface RuntimeObservation {
  state: ObservedState
  /** When the state last changed, where the provider says; else when it was looked at. */
  at: Date
  exit?: { code: number; oom: boolean }
  /**
   * When it last stopped on its own, failing, where the provider started it again rather than
   * leave it stopped: the same configuration, which usually stops the same way.
   */
  failedAt?: Date
  /** The provider can't reach the host the compute is on; its storage may be gone with it. */
  hostLost?: boolean
  /**
   * The handle to keep, from `observe`, where the provider brought the compute back at another
   * address without being asked. Only an observation of the handle a server holds carries one.
   */
  handle?: RuntimeHandle
}

type RuntimeStep = 'allocating' | 'storage' | 'compute' | 'booting'

export interface ProgressSink {
  step(name: RuntimeStep): Promise<void>
  /** Persist immediately, so a crash mid-provision leaves nothing unfindable. */
  handle(handle: RuntimeHandle): Promise<void>
}

export type RestoreSource =
  | { kind: 'snapshot'; snapshot: SnapshotHandle }
  | {
      kind: 'archive'
      download: DownloadTarget
      /**
       * The sha256 the archive was written with, where its backup recorded one: a runtime that can
       * check what it downloaded refuses other bytes. Absent or null, nothing is checked.
       */
      sha256?: string | null
    }

/** Presigned by the ArchiveStore; consumed inside one operation, never persisted. */
export interface UploadTarget {
  url: string
  headers: Record<string, string>
}
export interface DownloadTarget {
  url: string
}

/** A part of an upload in parts as its sender put it: its number, from 1, and the store's ETag. */
export interface PutPart {
  number: number
  etag: string
}

/**
 * One object put in parts, as an S3 multipart upload. Every part but the last is `partSize`
 * bytes, part n goes to `urls[n - 1]` with `headers`, and an archive takes as many as it needs.
 * `complete` joins the parts that were put into the object; `abort` drops what was put, and is
 * safe to call after `complete`, or twice.
 */
export interface PartsUpload {
  partSize: number
  urls: string[]
  headers: Record<string, string>
  complete(parts: readonly PutPart[]): Promise<void>
  abort(): Promise<void>
}

/**
 * Where a runtime writes an archive: in one PUT (`put`) when it is no larger than `maxPutBytes`,
 * the most the store takes in one (R2: 5 GiB less 5 MiB), else in parts (`inParts`), asked for
 * with the archive's size, or more, once that is known. `most` asks for fewer, larger parts, for
 * a runtime that hands every link to a command line.
 */
export interface ArchiveTarget {
  put: UploadTarget
  maxPutBytes: number
  inParts(sizeBytes: number, most?: number): Promise<PartsUpload>
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface MinecraftRuntime {
  /** Recorded beside each handle it issues, so it is never handed another runtime's. */
  readonly provider: string
  /**
   * The most servers this runtime can hold at once, counting what each needs at its busiest,
   * where its provider limits that; null where nothing does. The platform's server cap is held
   * to it (§19.12).
   */
  readonly serverCeiling: number | null

  /** Pure: whether this runtime issued `handle`. Every handle it issues says so of itself. */
  owns(handle: RuntimeHandle): boolean
  /** Pure: whether this runtime took `snapshot`. */
  ownsSnapshot(snapshot: SnapshotHandle): boolean
  /**
   * Whether a server of this size could be placed where `placement` maps now: false where the
   * runtime doesn't serve the region, or has no room there. A hint for choosing among runtimes;
   * `ensureProvisioned` still throws RuntimeFull when the room went meanwhile.
   */
  hasRoom(placement: Placement, size: { memoryMb: number; storageGb: number }): Promise<boolean>

  /** Idempotent and convergent: creates whatever is missing for `key`, and leaves it started. */
  ensureProvisioned(
    key: RuntimeKey,
    placement: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    install?: InstallSeed | null,
  ): Promise<RuntimeHandle>
  /** New configuration; restarts the workload if it is running. May return a new handle. */
  apply(handle: RuntimeHandle, spec: RuntimeSpec): Promise<RuntimeHandle>
  /**
   * Idempotent. Returns the handle to keep, saved as `apply`'s is: compute a provider brings back
   * at another address comes with a new one.
   */
  start(handle: RuntimeHandle): Promise<RuntimeHandle>
  /**
   * Stops the workload as `stop` does, killing it where it won't stop, and starts it again on the
   * same compute, so its handle and endpoint stay as they are.
   */
  restart(handle: RuntimeHandle): Promise<void>
  /** Graceful, idempotent. */
  stop(handle: RuntimeHandle): Promise<void>
  /**
   * Kills the workload at once, without the grace a stop gives it to save, and leaves it stopped;
   * idempotent. For a stop that failed for good (§9).
   */
  forceStop(handle: RuntimeHandle): Promise<void>
  waitRunning(handle: RuntimeHandle, signal: AbortSignal): Promise<void>

  /** How long the provider keeps a snapshot, when it decides that; null when it keeps them until deleted. */
  readonly snapshotLifetimeDays: number | null
  snapshot(handle: RuntimeHandle): Promise<{ snapshot: SnapshotHandle; sizeBytes: number; at: Date }>
  /**
   * Which of `snapshots` the provider no longer holds, told by its own identity: a stored handle
   * need not match how the provider would write it today, and may name storage the server has
   * since left behind (a restore or a move replaces it). One it can't tell about, including
   * another provider's, isn't gone; its `expiresAt` still ends it.
   */
  goneSnapshots(snapshots: readonly SnapshotHandle[]): Promise<ReadonlySet<SnapshotHandle>>
  /**
   * Frees a snapshot's storage. Providers whose snapshots only expire throw RuntimeUnsupported;
   * those snapshots live out `snapshotLifetimeDays`. Missing snapshots count as deleted.
   */
  deleteSnapshot(snapshot: SnapshotHandle): Promise<void>
  /**
   * Replaces storage, and compute where the provider requires it. Returns the new handle. From an
   * archive it also works on a handle `release` returned: fresh storage filled from the archive,
   * fresh compute on it, left stopped. A handle that `release` only got partway through works the
   * same way, and whatever the release left behind goes.
   */
  restore(
    handle: RuntimeHandle,
    from: RestoreSource,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle>
  /**
   * Moves compute and storage to where `to` maps now. `from`: the host is lost, and the volume
   * with it; the new storage comes from this snapshot instead, and the old compute is left for
   * the provider to clear.
   */
  relocate(
    handle: RuntimeHandle,
    to: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    from?: SnapshotHandle,
  ): Promise<RuntimeHandle>
  /**
   * Packs a snapshot's world into the archive store, at `target`: in one PUT, or in parts when it
   * is larger than one PUT carries. RuntimeUnsupported when this world can't be packed at all,
   * which no retry changes.
   */
  exportSnapshot(
    snapshot: SnapshotHandle,
    target: ArchiveTarget,
  ): Promise<{ sizeBytes: number; sha256: string }>
  /** Short maintenance commands inside the running workload. */
  exec(handle: RuntimeHandle, command: readonly string[], timeoutSeconds: number): Promise<ExecResult>

  /** Removes compute and keeps storage and snapshots (soft delete). */
  decommission(handle: RuntimeHandle): Promise<void>
  /**
   * Lets go of compute and storage once a server's world is safe elsewhere. The
   * handle it returns names neither, and still serves `endpoint`, since a resting server keeps its
   * route; `restore` from an archive, which brings both back; and `destroy`. Idempotent: what is
   * already gone counts as let go, so a release that stopped partway can simply be asked again.
   */
  release(handle: RuntimeHandle): Promise<RuntimeHandle>
  /**
   * A handle for a server this runtime holds nothing for, as `release` leaves one: it serves
   * `endpoint`, `restore` from an archive, which makes storage and compute, and `destroy`. How a
   * world in the archive store comes to a runtime it never ran on (a move between runtimes).
   * Idempotent; makes nothing that bills.
   */
  adopt(key: RuntimeKey, placement: Placement, spec: RuntimeSpec): Promise<RuntimeHandle>
  /** Removes everything. Missing resources count as done. */
  destroy(target: RuntimeKey | RuntimeHandle): Promise<void>

  observe(handle: RuntimeHandle): Promise<RuntimeObservation>
  /**
   * What changed at the provider since `since`, from one listing of the deployment's compute
   * rather than a call per server; the adapter widens the window, since changes can be listed
   * late. Compute that is gone is reported `absent`. When part of the listing couldn't be read,
   * it throws after yielding the rest.
   */
  observeChanged(
    since: Date,
  ): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle; observation: RuntimeObservation }>
  /**
   * Pure: whether the compute a handle names sits where `placement` maps now. A product region
   * remapped after its provider region was deprecated no longer does (§2): the server moves.
   */
  isPlaced(handle: RuntimeHandle, placement: Placement): boolean
  /**
   * Pure: whether two handles name the same compute. A restore or move may replace it, and an
   * observation of what it replaced says nothing about the server any more.
   */
  sameCompute(a: RuntimeHandle, b: RuntimeHandle): boolean
  /** Everything this deployment owns at the provider. */
  inventory(): AsyncIterable<{ key: RuntimeKey; handle: RuntimeHandle }>

  /**
   * Pure, from the handle alone: where `audience` reaches `port`. It answers for every handle this
   * runtime issued, the one `release` returns included: a resting server keeps its route, since a
   * join is what wakes it. The edge's routes are read from the current handle on every poll, and
   * a wake answers with the destination once the server is up, so an endpoint may change when a
   * restore, a move or a release issues a new handle; one that stays put, as FlyRuntime's does,
   * only spares the edge a change of route.
   */
  endpoint(handle: RuntimeHandle, port: string, audience: Audience): Endpoint
  /**
   * Whether a stopped server's endpoint still reaches that server and nothing else, as a Flycast
   * address does. Where a provider may give a stopped server's address to other compute, the edge
   * routes the server nowhere until it runs again, and a wake answers with where it runs then.
   */
  readonly stableEndpoints: boolean

  /**
   * Writes what tells servers apart onto what the provider lists for them, in its console and its
   * tools: whose server it is and what it's called, which the names it was given when it was made
   * can't say, since those never change. Tags are never part of what a server runs: nothing
   * restarts, no digest sees them, and compute a change or a move makes keeps them. Only a server
   * whose tags differ from what the provider holds is written, so asking with every server is the
   * backfill too, and a server with no compute has nowhere to hold them until it has some. Returns
   * how many it wrote; a runtime with nowhere to put them writes none.
   */
  tag(servers: ReadonlyMap<RuntimeKey, RuntimeTags>): Promise<number>
  /**
   * Pure, from the handle: what the provider calls what it holds for a server, for an operator
   * looking for it there, and a link to it in the provider's console where it has one.
   */
  locate(handle: RuntimeHandle): RuntimeLocation
  /**
   * Pure: the provider's list prices, in US cents, for a server of this size where a handle
   * places it: an hour of compute while it runs, and a month of the storage it holds whether it
   * runs or not. Null where the provider doesn't bill by the server.
   */
  prices(handle: RuntimeHandle, size: { memoryMb: number; storageGb: number }): RuntimePrices | null
  /**
   * The machines it holds and what they cost, where it pays for capacity whether or not servers
   * fill it (a fleet's nodes); null where only the servers on it are billed.
   */
  capacity(): Promise<RuntimeCapacity | null>
}

/** One machine a runtime pays for whether servers fill it or not. */
export interface RuntimeMachine {
  name: string
  region: string
  /** The runtime's word for how it is: active, draining… */
  state: string
  /** Its list price a month, in US cents, where its operator gave one. */
  monthlyCents: number | null
  /** Memory servers may be placed in, after what the machine keeps for itself. */
  allocatableMemoryMb: number
  /** Memory the servers running on it, or starting, are counted for: what a start needs room beside. */
  allocatedMemoryMb: number
  /** Memory of every server placed on it, running or asleep; where sleeping ones hold none, more than it has. */
  placedMemoryMb: number
  /** Memory it reports in use, where it reports it. */
  usedMemoryMb: number | null
  cpus: number
  /** CPU the servers running on it, or starting, are counted for, in thousandths of a core. */
  allocatedCpuMillis: number
  /** CPU it reports in use, in cores, where it reports it. */
  usedCpuCores: number | null
  servers: number
}

export interface RuntimeCapacity {
  machines: readonly RuntimeMachine[]
}

/**
 * Tags by name, in lowercase letters and underscores. They say who and what to an operator, and
 * never hold a secret, since the provider shows them. An adapter may shorten a long value.
 */
export type RuntimeTags = Readonly<Record<string, string>>

export interface RuntimeLocation {
  /** The provider's names, in the order an operator reads them: `app`, `machine`, `region`… */
  names: ReadonlyArray<{ label: string; value: string }>
  link: string | null
}

export interface RuntimePrices {
  runningHourCents: number
  storageMonthCents: number
}

/** Thrown by an adapter for a capability its provider does not have. */
export class RuntimeUnsupported extends Error {
  constructor(provider: string, what: string) {
    super(`The ${provider} runtime does not support ${what}`)
    this.name = 'RuntimeUnsupported'
  }
}

/**
 * Thrown by an adapter when the provider has no room for the server where it belongs right now:
 * a wait passes it, and the owner is told so rather than what the provider said.
 */
export class RuntimeFull extends Error {
  constructor(provider: string, detail: string) {
    super(`The ${provider} runtime has no room: ${detail}`)
    this.name = 'RuntimeFull'
  }
}
