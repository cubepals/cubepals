/**
 * The local provider: one container and one named volume per server, on a network only the edge
 * also joins. It knows nothing about Minecraft; it runs whatever spec it is given.
 *
 * The runtime is the port's verbs over each server's container and volume, which share its names,
 * its deployment check and its inventory, so they stay here. What has a job, state or failures of
 * its own is in its parts: the labels, image pulls, helper containers, the archive store, installs,
 * host ports, and what a game container is made with.
 *
 * Parts (`docker-runtime/`):
 * - `archives.ts`: a volume's files to and from the archive store, as a tar.gz.
 * - `engine.test.ts`: what the runtime asks of the Docker daemon in each flow, against a fake one.
 * - `game-container.ts`: the create options of a server's game container, from its spec.
 * - `helper.ts`: one-shot containers over volumes, removed when they end, within a deadline.
 * - `host-ports.ts`: free host ports, handed out one claim at a time.
 * - `images.ts`: an image pulled when the daemon lacks it, within a deadline.
 * - `installs.ts`: a release's install copied into a new server's volume, made once when missing.
 * - `labels.ts`: the labels that mark Docker resources as one deployment's.
 */

import { PassThrough } from 'node:stream'
import Docker from 'dockerode'
import type {
  ArchiveTarget,
  Audience,
  Endpoint,
  ExecResult,
  InstallSeed,
  MinecraftRuntime,
  Placement,
  ProgressSink,
  RestoreSource,
  RuntimeHandle,
  RuntimeKey,
  RuntimeLocation,
  RuntimeObservation,
  RuntimeSpec,
  SnapshotHandle,
} from '../../app/ports/runtime.ts'
import { exportArchive, unpackArchive } from './docker-runtime/archives.ts'
import { gameContainer, specDigest } from './docker-runtime/game-container.ts'
import { HELPER_IMAGE, helperRunner, type RunHelper } from './docker-runtime/helper.ts'
import { HostPorts } from './docker-runtime/host-ports.ts'
import { ensureImage } from './docker-runtime/images.ts'
import { Installs } from './docker-runtime/installs.ts'
import {
  LABEL_DEPLOYMENT,
  LABEL_DIGEST,
  LABEL_PORTS,
  LABEL_SERVER,
  LABEL_SNAPSHOT,
  LABEL_STOP_TIMEOUT,
} from './docker-runtime/labels.ts'
import {
  type DockerRef,
  decodeHandle,
  decodeSnapshot,
  encodeHandle,
  encodeSnapshot,
  isHandle,
  isSnapshot,
} from './handle.ts'

export interface DockerRuntimeOptions {
  socketPath: string
  deploymentId: string
  gameNetwork: string
  /** The product regions it serves; without one, every region (one machine has no other). */
  regionMap?: Readonly<Record<string, string>>
}

export class DockerRuntime implements MinecraftRuntime {
  readonly provider = 'docker'
  /** A container's name, on the deployment's own games network. */
  readonly stableEndpoints = true
  /** No limit of its own: only this machine's memory and its free host ports bound how many run. */
  readonly serverCeiling = null
  /** Snapshots are volumes that stay until deleted. */
  readonly snapshotLifetimeDays = null
  readonly #docker: Docker
  readonly #deployment: string
  readonly #network: string
  readonly #regions: ReadonlySet<string> | null
  readonly #helper: RunHelper
  readonly #installs: Installs
  readonly #ports: HostPorts

  constructor(options: DockerRuntimeOptions) {
    this.#docker = new Docker({ socketPath: options.socketPath })
    this.#deployment = options.deploymentId
    this.#network = options.gameNetwork
    this.#regions = options.regionMap === undefined ? null : new Set(Object.keys(options.regionMap))
    this.#helper = helperRunner(this.#docker, this.#deployment)
    this.#installs = new Installs(this.#docker, this.#deployment, this.#helper)
    this.#ports = new HostPorts(() => this.#containers())
  }

  owns(handle: RuntimeHandle): boolean {
    return isHandle(handle)
  }

  /** This machine, which nothing here prices. */
  async capacity(): Promise<null> {
    return null
  }

  ownsSnapshot(snapshot: SnapshotHandle): boolean {
    return isSnapshot(snapshot)
  }

  /** One machine: its room is its memory and ports, which Docker doesn't count ahead. */
  /** Room on this machine is never measured; a region its map doesn't name is never its to place. */
  async hasRoom(placement: Placement): Promise<boolean> {
    return this.#regions === null || this.#regions.has(placement.regionKey)
  }

  /** The names it would make for the server, with no container or volume behind them yet. */
  async adopt(key: RuntimeKey, _placement: Placement, spec: RuntimeSpec): Promise<RuntimeHandle> {
    const names = this.#names(key)
    return encodeHandle({
      deployment: this.#deployment,
      serverId: key,
      container: names.container,
      volume: names.volume,
      ports: Object.fromEntries(spec.ports.map((port) => [port.name, { container: port.port, host: null }])),
    })
  }

  async ensureProvisioned(
    key: RuntimeKey,
    _placement: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    install: InstallSeed | null = null,
  ): Promise<RuntimeHandle> {
    await progress.step('allocating')
    await this.#requireNetwork()
    await ensureImage(this.#docker, spec.image)

    await progress.step('storage')
    const names = this.#names(key)
    await this.#ensureVolume(names.volume, key)

    await progress.step('compute')
    const existing = await this.#inspect(names.container)
    let ref: DockerRef
    if (existing && existing.Config.Labels[LABEL_DIGEST] === specDigest(spec)) {
      ref = refFromContainer(existing, this.#deployment, key)
    } else if (existing) {
      ref = refFromContainer(existing, this.#deployment, key)
      await this.#remove(names.container, spec.stop.timeoutSeconds)
      await this.#create(ref, spec)
    } else {
      // A port is taken once a container records it, so choosing and creating happen one at a time.
      ref = await this.#ports.claim(spec, async (ports) => {
        const created = {
          deployment: this.#deployment,
          serverId: key,
          container: names.container,
          volume: names.volume,
          ports,
        }
        await this.#create(created, spec)
        return created
      })
    }
    const handle = encodeHandle(ref)
    await progress.handle(handle)

    await progress.step('booting')
    if (install !== null) await this.#installs.seed(names.volume, spec, install)
    await this.start(handle)
    return handle
  }

  async apply(handle: RuntimeHandle, spec: RuntimeSpec): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    const current = await this.#inspect(ref.container)
    const wasRunning = current?.State.Running === true
    if (current) await this.#remove(ref.container, spec.stop.timeoutSeconds)
    await ensureImage(this.#docker, spec.image)
    await this.#create(ref, spec)
    if (wasRunning) await this.start(handle)
    return handle
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const { container } = decodeHandle(handle)
    await this.#docker.getContainer(container).start().catch(ignoreStatus(304))
    return handle
  }

  async restart(handle: RuntimeHandle): Promise<void> {
    await this.stop(handle).catch(() => this.forceStop(handle))
    await this.start(handle)
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    const { container } = decodeHandle(handle)
    const info = await this.#inspect(container)
    if (!info?.State.Running) return
    const timeout = Number(info.Config.Labels[LABEL_STOP_TIMEOUT] ?? '90')
    await this.#docker.getContainer(container).stop({ t: timeout }).catch(ignoreStatus(304, 404))
  }

  async forceStop(handle: RuntimeHandle): Promise<void> {
    const { container } = decodeHandle(handle)
    // 409: not running; 404: gone. Either way nothing is left to kill.
    await this.#docker.getContainer(container).kill().catch(ignoreStatus(404, 409))
  }

  async waitRunning(handle: RuntimeHandle, signal: AbortSignal): Promise<void> {
    const { container } = decodeHandle(handle)
    while (!signal.aborted) {
      const info = await this.#inspect(container)
      if (info === null) throw new Error('The container is gone')
      if (info.State.Running) return
      if (info.State.Status === 'exited' || info.State.Status === 'dead')
        throw new Error(`The container exited with code ${info.State.ExitCode}`)
      await sleep(500)
    }
    throw new Error('The container did not start in time')
  }

  async snapshot(handle: RuntimeHandle) {
    const ref = decodeHandle(handle)
    const at = new Date()
    const volume = `${ref.volume}-snap-${at.getTime()}`
    await this.#docker.createVolume({
      Name: volume,
      Labels: {
        [LABEL_DEPLOYMENT]: this.#deployment,
        [LABEL_SERVER]: ref.serverId,
        [LABEL_SNAPSHOT]: ref.volume,
      },
    })
    const sizeBytes = await this.#copyVolume(ref.volume, volume)
    return { snapshot: encodeSnapshot(volume), sizeBytes, at }
  }

  async deleteSnapshot(snapshot: SnapshotHandle): Promise<void> {
    await this.#docker.getVolume(decodeSnapshot(snapshot)).remove().catch(ignoreStatus(404))
  }

  /** A snapshot is a volume of its own, so it is gone when this deployment has no such volume. */
  async goneSnapshots(snapshots: readonly SnapshotHandle[]): Promise<ReadonlySet<SnapshotHandle>> {
    const ours = snapshots.filter((snapshot) => isSnapshot(snapshot))
    if (ours.length === 0) return new Set()
    const { Volumes } = await this.#docker.listVolumes({
      filters: { label: [LABEL_SNAPSHOT, `${LABEL_DEPLOYMENT}=${this.#deployment}`] },
    })
    const held = new Set((Volumes ?? []).map((v) => v.Name))
    return new Set(ours.filter((snapshot) => !held.has(decodeSnapshot(snapshot))))
  }

  async restore(
    handle: RuntimeHandle,
    from: RestoreSource,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    await progress.step('storage')
    const wasRunning = (await this.#inspect(ref.container))?.State.Running === true
    await this.stop(handle)
    // A released server's volume is gone: it is made again, labelled as the server's, before
    // anything is put in it.
    await this.#ensureVolume(ref.volume, ref.serverId as RuntimeKey)
    if (from.kind === 'snapshot')
      await this.#copyVolume(decodeSnapshot(from.snapshot), ref.volume, { wipeTarget: true })
    // The helper fetches the archive the way a game runtime would reach the store, and checks
    // it is a whole tarball before the volume is emptied: a bad download leaves the world alone.
    else await unpackArchive(this.#helper, ref.volume, from.download)
    await progress.step('compute')
    if ((await this.#inspect(ref.container)) !== null) {
      await this.apply(handle, spec)
      if (wasRunning) await this.start(handle)
      return handle
    }
    // Released, so there is no container: a new one, on free host ports, since the ones it had
    // may have gone to another server meanwhile.
    await ensureImage(this.#docker, spec.image)
    const fresh = await this.#ports.claim(spec, async (ports) => {
      const made = { ...ref, ports }
      await this.#create(made, spec)
      return made
    })
    const restored = encodeHandle(fresh)
    await progress.handle(restored)
    return restored
  }

  async relocate(
    handle: RuntimeHandle,
    _to: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    from?: SnapshotHandle,
  ): Promise<RuntimeHandle> {
    // One machine, one place: moving is a no-op here, and rebuilding from a snapshot a restore.
    if (from === undefined) return handle
    return this.restore(handle, { kind: 'snapshot', snapshot: from }, spec, progress)
  }

  isPlaced(_handle: RuntimeHandle, _placement: Placement): boolean {
    return true
  }

  /**
   * A tar.gz of the snapshot's files, put where `target` says from a one-shot helper container. It
   * is packed into a volume of its own, so that one larger than a PUT carries waits there for a
   * second helper, which sends it in parts.
   */
  async exportSnapshot(
    snapshot: SnapshotHandle,
    target: ArchiveTarget,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const scratch = `${decodeSnapshot(snapshot)}-export-${Date.now()}`
    await this.#docker.createVolume({ Name: scratch, Labels: { [LABEL_DEPLOYMENT]: this.#deployment } })
    try {
      return await exportArchive(this.#helper, decodeSnapshot(snapshot), scratch, target)
    } finally {
      await this.#docker.getVolume(scratch).remove().catch(ignoreStatus(404))
    }
  }

  async exec(handle: RuntimeHandle, command: readonly string[], timeoutSeconds: number): Promise<ExecResult> {
    const { container } = decodeHandle(handle)
    const exec = await this.#docker
      .getContainer(container)
      .exec({ Cmd: [...command], AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({ hijack: true, stdin: false })
    const stdout = collect()
    const stderr = collect()
    this.#docker.modem.demuxStream(stream, stdout.sink, stderr.sink)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy()
        reject(new Error('The command timed out'))
      }, timeoutSeconds * 1000)
      stream.on('end', () => {
        clearTimeout(timer)
        resolve()
      })
      stream.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    const info = await exec.inspect()
    return { exitCode: info.ExitCode ?? -1, stdout: stdout.text(), stderr: stderr.text() }
  }

  async decommission(handle: RuntimeHandle): Promise<void> {
    const ref = decodeHandle(handle)
    await this.#remove(ref.container, 90)
  }

  /** The container goes, then the world's volume and its snapshots; the handle keeps its names. */
  async release(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    if (ref.deployment !== this.#deployment)
      throw new Error(`${ref.container} does not belong to deployment ${this.#deployment}`)
    await this.#remove(ref.container, 30)
    const { Volumes } = await this.#docker.listVolumes({
      filters: { label: [`${LABEL_SNAPSHOT}=${ref.volume}`, `${LABEL_DEPLOYMENT}=${this.#deployment}`] },
    })
    for (const volume of Volumes ?? [])
      await this.#docker.getVolume(volume.Name).remove().catch(ignoreStatus(404))
    await this.#docker.getVolume(ref.volume).remove().catch(ignoreStatus(404))
    return handle
  }

  async destroy(target: RuntimeKey | RuntimeHandle): Promise<void> {
    const ref = target.startsWith('docker:')
      ? decodeHandle(target)
      : { ...this.#names(target as RuntimeKey), serverId: target, deployment: this.#deployment }
    // Never another deployment's servers, whatever a caller passes (§19.7): not a handle it
    // issued, nor a container or volume that carries its label.
    const foreign = () => new Error(`${ref.container} does not belong to deployment ${this.#deployment}`)
    if (ref.deployment !== this.#deployment) throw foreign()
    const container = await this.#inspect(ref.container)
    if (container !== null && container.Config.Labels[LABEL_DEPLOYMENT] !== this.#deployment) throw foreign()
    const volume = await this.#docker
      .getVolume(ref.volume)
      .inspect()
      .catch((error: unknown) => {
        if (statusOf(error) === 404) return null
        throw error
      })
    if (volume !== null && volume.Labels?.[LABEL_DEPLOYMENT] !== this.#deployment) throw foreign()
    await this.#remove(ref.container, 30)
    const { Volumes } = await this.#docker.listVolumes({
      filters: { label: [`${LABEL_SERVER}=${ref.serverId}`, `${LABEL_DEPLOYMENT}=${this.#deployment}`] },
    })
    for (const volume of Volumes ?? [])
      await this.#docker.getVolume(volume.Name).remove().catch(ignoreStatus(404))
    await this.#docker.getVolume(ref.volume).remove().catch(ignoreStatus(404))
  }

  async observe(handle: RuntimeHandle): Promise<RuntimeObservation> {
    const { container } = decodeHandle(handle)
    return observation(await this.#inspect(container))
  }

  /**
   * The daemon keeps no history to page through, and listing it is local and cheap: every
   * container is read, and those that started or stopped since `since` (a minute earlier, as on
   * Fly) are reported. A server whose container is gone still has its volume; it is absent.
   */
  async *observeChanged(since: Date) {
    const after = since.getTime() - 60_000
    const seen = new Set<string>()
    for (const summary of await this.#containers()) {
      const info = await this.#inspect(summary.Id)
      if (info === null) continue
      const key = info.Config.Labels[LABEL_SERVER] as RuntimeKey
      seen.add(key)
      const observed = observation(info)
      if (observed.at.getTime() < after) continue
      yield {
        key,
        handle: encodeHandle(refFromContainer(info, this.#deployment, key)),
        observation: observed,
      }
    }
    for await (const { key, handle } of this.#withoutContainer(seen))
      yield { key, handle, observation: { state: 'absent' as const, at: new Date() } }
  }

  sameCompute(a: RuntimeHandle, b: RuntimeHandle): boolean {
    return decodeHandle(a).container === decodeHandle(b).container
  }

  async *inventory() {
    const seen = new Set<string>()
    for (const summary of await this.#containers()) {
      const info = await this.#inspect(summary.Id)
      if (info === null) continue
      const key = info.Config.Labels[LABEL_SERVER] as RuntimeKey
      seen.add(key)
      yield { key, handle: encodeHandle(refFromContainer(info, this.#deployment, key)) }
    }
    yield* this.#withoutContainer(seen)
  }

  endpoint(handle: RuntimeHandle, port: string, audience: Audience): Endpoint {
    const ref = decodeHandle(handle)
    const mapping = ref.ports[port]
    if (!mapping) throw new Error(`This runtime exposes no port named ${port}`)
    if (audience === 'edge') return { host: ref.container, port: mapping.container }
    if (mapping.host === null) throw new Error(`Port ${port} is not reachable from the control plane`)
    return { host: '127.0.0.1', port: mapping.host }
  }

  /** A container's labels are fixed once it is made, and the one host is seen with `docker ps`. */
  async tag(): Promise<number> {
    return 0
  }

  locate(handle: RuntimeHandle): RuntimeLocation {
    const ref = decodeHandle(handle)
    return {
      names: [
        { label: 'Container', value: ref.container },
        { label: 'Volume', value: ref.volume },
      ],
      link: null,
    }
  }

  /** The deployment's own host, paid for whatever runs on it. */
  prices(): null {
    return null
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────

  /** Decommissioned servers, and ones whose container went, keep their volume without one. */
  async *#withoutContainer(seen: Set<string>) {
    const { Volumes } = await this.#docker.listVolumes({
      filters: { label: [`${LABEL_DEPLOYMENT}=${this.#deployment}`] },
    })
    for (const volume of Volumes ?? []) {
      const key = volume.Labels?.[LABEL_SERVER] as RuntimeKey | undefined
      if (key === undefined || seen.has(key) || volume.Labels?.[LABEL_SNAPSHOT]) continue
      seen.add(key)
      const names = this.#names(key)
      yield {
        key,
        handle: encodeHandle({ deployment: this.#deployment, serverId: key, ...names, ports: {} }),
      }
    }
  }

  #names(key: RuntimeKey) {
    const base = `bly-${this.#deployment}-${key.replace(/-/g, '')}`
    return { container: base, volume: `${base}-data` }
  }

  async #containers() {
    return this.#docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_DEPLOYMENT}=${this.#deployment}`] },
    })
  }

  async #inspect(container: string): Promise<Docker.ContainerInspectInfo | null> {
    try {
      return await this.#docker.getContainer(container).inspect()
    } catch (error) {
      if (statusOf(error) === 404) return null
      throw error
    }
  }

  /** The games network is the deployment's (docker-compose.yml), not something a runtime invents. */
  async #requireNetwork(): Promise<void> {
    const networks = await this.#docker.listNetworks({ filters: { name: [this.#network] } })
    if (!networks.some((n) => n.Name === this.#network))
      throw new Error(`The ${this.#network} network is missing. Run \`docker compose up -d\` first.`)
  }

  async #ensureVolume(name: string, key: RuntimeKey): Promise<void> {
    const found = await this.#docker
      .getVolume(name)
      .inspect()
      .catch(() => null)
    if (found) return
    await this.#docker.createVolume({
      Name: name,
      Labels: { [LABEL_DEPLOYMENT]: this.#deployment, [LABEL_SERVER]: key },
    })
  }

  async #create(ref: DockerRef, spec: RuntimeSpec): Promise<void> {
    await this.#docker.createContainer(gameContainer(ref, spec, this.#deployment, this.#network))
  }

  async #remove(container: string, timeoutSeconds: number): Promise<void> {
    const handle = this.#docker.getContainer(container)
    await handle.stop({ t: timeoutSeconds }).catch(ignoreStatus(304, 404))
    await handle.remove({ force: true }).catch(ignoreStatus(404))
  }

  /** Copies one volume's files into another and returns how many bytes the copy takes. */
  async #copyVolume(from: string, to: string, options: { wipeTarget?: boolean } = {}): Promise<number> {
    const script = `${options.wipeTarget ? 'find /to -mindepth 1 -delete && ' : ''}cp -a /from/. /to/ && du -sk /to`
    const output = await this.#helper(HELPER_IMAGE, ['sh', '-c', script], {
      mounts: [
        { Type: 'volume', Source: from, Target: '/from', ReadOnly: true },
        { Type: 'volume', Source: to, Target: '/to' },
      ],
    })
    return Number.parseInt(output.trim().split(/\s+/)[0] ?? '0', 10) * 1024
  }
}

function refFromContainer(info: Docker.ContainerInspectInfo, deployment: string, key: RuntimeKey): DockerRef {
  const container = info.Name.replace(/^\//, '')
  const volume = info.Mounts.find((m) => m.Type === 'volume')?.Name ?? `${container}-data`
  const ports = JSON.parse(info.Config.Labels[LABEL_PORTS] ?? '{}') as DockerRef['ports']
  return { deployment, serverId: key, container, volume, ports }
}

function observation(info: Docker.ContainerInspectInfo | null): RuntimeObservation {
  if (info === null) return { state: 'absent', at: new Date() }
  const state = info.State
  const at = changedAt(state) ?? new Date()
  if (state.Running) return { state: 'running', at }
  if (state.Restarting) return { state: 'starting', at }
  if (state.Status === 'created') return { state: 'stopped', at }
  const exit = { code: state.ExitCode, oom: state.OOMKilled }
  // Exit code 0 after a stop request is a clean stop; anything else crashed.
  return { state: state.ExitCode === 0 || state.ExitCode === 143 ? 'stopped' : 'crashed', at, exit }
}

/** When the container last started or stopped, as the daemon recorded it; never is year 1. */
function changedAt(state: Docker.ContainerInspectInfo['State']): Date | null {
  const times = [state.StartedAt, state.FinishedAt].map(Date.parse).filter((time) => time > 0)
  return times.length === 0 ? null : new Date(Math.max(...times))
}

function collect() {
  const chunks: Buffer[] = []
  const sink = new PassThrough()
  sink.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { sink, text: () => Buffer.concat(chunks).toString('utf8') }
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode: number }).statusCode
    : undefined
}

function ignoreStatus(...codes: number[]) {
  return (error: unknown) => {
    if (!codes.includes(statusOf(error) ?? -1)) throw error
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
