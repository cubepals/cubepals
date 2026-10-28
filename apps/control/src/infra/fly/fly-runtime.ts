// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fly Machines: one app per server, on a private network of its own, with one volume and at most
 * one Minecraft machine, reached through the app's Flycast address. List-before-create is the
 * idempotency, and every change to a machine holds its lease. It knows nothing about Minecraft;
 * it runs whatever spec it is given (docs/architecture.md §8).
 *
 * Parts (`fly-runtime/`):
 * - `responses.ts`: a Fly answer as its value or the error it means.
 * - `observation.ts`: a machine's state and exit events as the port's observation.
 * - `prices.ts`: an hour and a month of a server, at Fly's list prices.
 * - `regions.ts`: the product's regions on Fly's, and whether one has room.
 * - `room.ts`: waiting for a machine while the organization is at its machine limit.
 * - `apps.ts`: a server's Fly app, its name, its Flycast address and its secrets.
 * - `volumes.ts`: the volumes a server's world lives on.
 * - `snapshots.ts`: a volume's snapshots, taken and accounted for.
 * - `machines.ts`: Fly machines read, changed under their lease, and waited on.
 * - `helper-machine.ts`: one shell job on a throwaway machine.
 * - `helper-jobs.ts`: the scripts helper machines run, and what they print.
 * - `discovery.ts`: this deployment's servers found among the organization's apps and machines.
 * - `tags.ts`: servers' tags written onto their machines' metadata.
 * - `strays.ts`: machines in a server's app that nothing names, found and destroyed.
 */

import type {
  ArchiveTarget,
  Audience,
  Endpoint,
  ExecResult,
  HeldStorage,
  InstallSeed,
  MinecraftRuntime,
  Placement,
  ProgressSink,
  PutPart,
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
import { RuntimeUnsupported } from '../../app/ports/runtime.ts'
import type { FlyClient, FlySchemas } from './client.ts'
import {
  appName,
  deleteApp,
  ensureApp,
  ensureFlycast,
  requireOwnApp,
  setSecrets,
} from './fly-runtime/apps.ts'
import { changedSince, inventory } from './fly-runtime/discovery.ts'
import {
  exportJob,
  PARTS_PER_JOB,
  partBatches,
  partsJob,
  partsPut,
  restoreJob,
} from './fly-runtime/helper-jobs.ts'
import { helperJob } from './fly-runtime/helper-machine.ts'
import {
  afterReplace,
  createMachine,
  destroyMachine,
  exec,
  machineOnVolume,
  minecraftMachine,
  readMachine,
  sleepMachine,
  startMachine,
  stopMachine,
  untilStarted,
  updateMachine,
} from './fly-runtime/machines.ts'
import { observationOf } from './fly-runtime/observation.ts'
import { pricesOf } from './fly-runtime/prices.ts'
import { checkRegions, flyRegion, placeable, requireCapacity } from './fly-runtime/regions.ts'
import { idOf } from './fly-runtime/responses.ts'
import { ROOM_WAIT, type RoomWait, whenRoom } from './fly-runtime/room.ts'
import { goneSnapshots, takeSnapshot } from './fly-runtime/snapshots.ts'
import { clearExports, clearOtherServers, destroyStrays } from './fly-runtime/strays.ts'
import { tagMachines } from './fly-runtime/tags.ts'
import {
  clearEarlierWakes,
  createVolume,
  dataVolume,
  deleteLeftoverVolumes,
  deleteVolume,
  EXPORT_VOLUME_NAME,
  ensureVolume,
  fitVolume,
  readVolume,
  VOLUME_NAME,
  volumeReady,
} from './fly-runtime/volumes.ts'
import {
  decodeHandle,
  decodeSnapshot,
  encodeHandle,
  type FlyRef,
  isFlyHandle,
  isFlySnapshot,
} from './handle.ts'
import { asleepOn, heldTags, META, machineConfig, portsOf, startStep } from './machine-config.ts'

export { keyFromApp } from './fly-runtime/apps.ts'
export { exportJob, partBatches, partsJob, partsPut, restoreJob } from './fly-runtime/helper-jobs.ts'
export { observationOf, stateOf } from './fly-runtime/observation.ts'

type Machine = FlySchemas['Machine']
type Volume = FlySchemas['Volume']
type MachineConfig = FlySchemas['fly.MachineConfig']

export interface FlyRuntimeOptions {
  client: FlyClient
  org: string
  deploymentId: string
  /** Product region key → Fly region code. */
  regionMap: Readonly<Record<string, string>>
  /** How long Fly keeps a volume's snapshots: the longest any plan needs one. */
  snapshotRetentionDays: number
  /** The organization's machine limit, and the machines the platform itself runs in it (§19.12). */
  machineLimit: number
  platformMachines: number
  /**
   * Whether a sleep suspends rather than stops, asked at each one (`app/platform/suspend-switch.ts`).
   * Without it, it has no `sleep`, and the control plane stops servers instead.
   */
  suspend?: () => Promise<boolean>
  /** How work that needs one more machine waits for one at the limit; tests shorten it. */
  roomWait?: RoomWait
}

/** Fly keeps a volume's snapshots for 1 to 60 days (fly.io/docs/volumes/snapshots). */
const SNAPSHOT_RETENTION = { min: 1, max: 60 }

/**
 * Machines kept free beside one a server, for the few that run for a while at once: a restore's
 * or a move's new machine before the old one goes (`#replace`), a helper's (`helperJob`). Work
 * that finds none free waits for one (`whenRoom`).
 */
const HELPER_HEADROOM = 2

/** The servers an organization's machine limit holds, beside the platform's own machines (§19.12). */
export function serverCeilingOf(machineLimit: number, platformMachines: number): number {
  return Math.max(0, machineLimit - platformMachines - HELPER_HEADROOM)
}

export class FlyRuntime implements MinecraftRuntime {
  readonly provider = 'fly'
  readonly stableEndpoints = true
  /** Every machine counts against the organization's limit, stopped ones included. */
  readonly serverCeiling: number
  readonly #fly: FlyClient
  readonly #org: string
  readonly #deployment: string
  readonly #regions: Readonly<Record<string, string>>
  /** Set on every volume Blockly creates: Fly deletes its snapshots after this, and only then. */
  readonly snapshotLifetimeDays: number
  readonly sleep?: (handle: RuntimeHandle) => Promise<'suspended' | 'stopped'>
  readonly #roomWait: RoomWait

  constructor(options: FlyRuntimeOptions) {
    this.#fly = options.client
    this.#org = options.org
    this.#deployment = options.deploymentId
    this.#regions = options.regionMap
    this.snapshotLifetimeDays = Math.min(
      SNAPSHOT_RETENTION.max,
      Math.max(SNAPSHOT_RETENTION.min, options.snapshotRetentionDays),
    )
    this.serverCeiling = serverCeilingOf(options.machineLimit, options.platformMachines)
    this.#roomWait = options.roomWait ?? ROOM_WAIT
    const suspends = options.suspend
    if (suspends !== undefined) this.sleep = (handle) => this.#sleep(handle, suspends)
  }

  async checkRegions(): Promise<void> {
    return checkRegions(this.#fly, this.#org, this.#regions)
  }

  owns(handle: RuntimeHandle): boolean {
    return isFlyHandle(handle)
  }

  /** Billed by the server, by the second it runs and the storage it keeps: no capacity of its own. */
  async capacity(): Promise<null> {
    return null
  }

  ownsSnapshot(snapshot: SnapshotHandle): boolean {
    return isFlySnapshot(snapshot)
  }

  /** A mapped region where Fly has a host for the size, as provisioning asks before making anything. */
  async hasRoom(placement: Placement, size: { memoryMb: number; storageGb: number }): Promise<boolean> {
    const code = this.#regions[placement.regionKey]
    if (!code) return false
    return placeable(this.#fly, this.#org, code, { memoryMb: size.memoryMb, sizeGb: size.storageGb })
  }

  /**
   * Nothing is made: a released server's handle names only its app, and the restore that brings
   * a world here makes sure of the app and its Flycast address, as a wake does.
   */
  async adopt(key: RuntimeKey, placement: Placement, spec: RuntimeSpec): Promise<RuntimeHandle> {
    return encodeHandle({
      deployment: this.#deployment,
      serverId: key,
      app: appName(this.#deployment, key),
      region: flyRegion(this.#regions, placement),
      volumeId: null,
      machineId: null,
      ports: portsOf(spec),
    })
  }

  async ensureProvisioned(
    key: RuntimeKey,
    placement: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    _install?: InstallSeed | null,
    storage: HeldStorage = {},
  ): Promise<RuntimeHandle> {
    const region = flyRegion(this.#regions, placement)
    const app = appName(this.#deployment, key)
    // The machine its handle names: an app can briefly hold two (`#replace`), in no listed order.
    const existing = await minecraftMachine(this.#fly, app, machineOf(storage))
    // Asleep on what it is asked to run: nothing to make, post or change, and a change would drop
    // the memory Fly kept, so it resumes as it was.
    const asleep = asleepOn(existing, spec)
    const { machine, volumeId } =
      existing !== null && asleep !== null
        ? { machine: existing, volumeId: asleep }
        : await this.#provision(key, app, region, spec, progress, existing, storage)
    const handle = encodeHandle({
      deployment: this.#deployment,
      serverId: key,
      app,
      region: machine.region ?? region,
      volumeId,
      machineId: idOf(machine, 'a machine'),
      ports: portsOf(spec),
    })
    await progress.handle(handle)

    await startStep(progress, existing, asleep)
    await this.start(handle)
    return handle
  }

  /** What a machine needs before it boots: its app, address, secrets and volume, and the machine itself. */
  async #provision(
    key: RuntimeKey,
    app: string,
    region: string,
    spec: RuntimeSpec,
    progress: ProgressSink,
    existing: Machine | null,
    storage: HeldStorage,
  ): Promise<{ machine: Machine; volumeId: string }> {
    await progress.step('allocating')
    // Nothing made yet: ask for room first, so a full region leaves no app or volume behind.
    if (existing === null) await requireCapacity(this.#fly, this.#org, region, spec)
    await ensureApp(this.#fly, this.#org, this.#deployment, app, key)
    await ensureFlycast(this.#fly, this.#org, app)
    const secretsVersion = await setSecrets(this.#fly, app, spec.secrets)

    await progress.step('storage')
    const volume = await ensureVolume(
      this.#fly,
      app,
      region,
      spec.storage.sizeGb,
      this.snapshotLifetimeDays,
      { mounted: existing?.config?.mounts?.[0]?.volume, ...volumesOf(storage) },
    )
    const volumeId = idOf(volume, 'a volume')

    await progress.step('compute')
    let machine = await minecraftMachine(this.#fly, app, existing?.id ?? null)
    const config = this.#config(key, spec, volumeId, machine)
    if (machine === null)
      machine = await createMachine(
        this.#fly,
        app,
        volume.region ?? region,
        config,
        secretsVersion,
        'minecraft',
      )
    else if (machine.config?.metadata?.[META.digest] !== config.metadata?.[META.digest])
      machine = await updateMachine(
        this.#fly,
        this.#deployment,
        app,
        idOf(machine, 'a machine'),
        config,
        secretsVersion,
        true,
      )
    return { machine, volumeId }
  }

  /**
   * Once an update before it is in place, as Fly refuses another meanwhile: an apply straight
   * after one, or going back from one that didn't start. A machine Fly replaced under the handle,
   * under a new id on the same volume, is the one changed, and the handle returned names it.
   */
  async apply(handle: RuntimeHandle, spec: RuntimeSpec): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    const volumeId = requireVolume(ref)
    const secretsVersion = await setSecrets(this.#fly, ref.app, spec.secrets)
    await fitVolume(this.#fly, ref.app, volumeId, spec.storage.sizeGb, this.snapshotLifetimeDays)
    const machine =
      (await afterReplace(this.#fly, ref.app, requireMachine(ref))) ??
      (await machineOnVolume(this.#fly, ref.app, volumeId))
    if (machine === null) throw new Error('The machine is gone')
    const machineId = idOf(machine, 'a machine')
    // Updating a started machine restarts it on the new config; a stopped one stays stopped.
    await updateMachine(
      this.#fly,
      this.#deployment,
      ref.app,
      machineId,
      this.#config(ref.serverId, spec, volumeId, machine),
      secretsVersion,
      machine.state !== 'started',
    )
    return encodeHandle({ ...ref, machineId, ports: portsOf(spec) })
  }

  /**
   * The Flycast address never moves, so the handle it returns is the one it was given. HostFull
   * when the machine's host has no room to run it now.
   */
  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    await startMachine(this.#fly, ref.app, requireMachine(ref))
    return handle
  }

  async restart(handle: RuntimeHandle): Promise<void> {
    await this.stop(handle).catch(() => this.forceStop(handle))
    await this.start(handle)
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    const ref = decodeHandle(handle)
    if (ref.machineId !== null)
      await stopMachine(this.#fly, this.#deployment, ref.app, ref.machineId, 'gracefully')
  }

  /**
   * Fly's suspend, while the switch is on. A machine not
   * running is stopped, and one Fly won't suspend too, so a sleep never fails for want of it.
   */
  async #sleep(handle: RuntimeHandle, suspends: () => Promise<boolean>): Promise<'suspended' | 'stopped'> {
    const ref = decodeHandle(handle)
    return ref.machineId === null
      ? 'stopped'
      : sleepMachine(this.#fly, this.#deployment, ref.app, ref.machineId, await suspends())
  }

  /**
   * A stop, not a signal: a machine stopped through the API stays stopped, where a killed process
   * would be restarted by the machine's on-failure policy.
   */
  async forceStop(handle: RuntimeHandle): Promise<void> {
    const ref = decodeHandle(handle)
    if (ref.machineId !== null)
      await stopMachine(this.#fly, this.#deployment, ref.app, ref.machineId, 'killed')
  }

  async waitRunning(handle: RuntimeHandle, signal: AbortSignal): Promise<void> {
    const ref = decodeHandle(handle)
    await untilStarted(this.#fly, ref.app, requireMachine(ref), signal)
  }

  async snapshot(handle: RuntimeHandle, taken?: () => void) {
    const ref = decodeHandle(handle)
    const volumeId = requireVolume(ref)
    return takeSnapshot(this.#fly, ref.app, ref.region, volumeId, taken)
  }

  /** Fly's API can't delete a volume snapshot; it expires after the volume's retention. */
  deleteSnapshot(_snapshot: SnapshotHandle): Promise<void> {
    return Promise.reject(new RuntimeUnsupported(this.provider, 'deleting snapshots before they expire'))
  }

  async goneSnapshots(snapshots: readonly SnapshotHandle[]): Promise<ReadonlySet<SnapshotHandle>> {
    return goneSnapshots(this.#fly, snapshots)
  }

  async restore(
    handle: RuntimeHandle,
    from: RestoreSource,
    spec: RuntimeSpec,
    progress: ProgressSink,
  ): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    // A released server holds nothing but its app: before anything is made, the region must have
    // room, so a full one leaves no volume behind, and the app is made sure of, as provisioning
    // does. Its Flycast address, and so the edge's route to it, are the ones it always had.
    if (ref.machineId === null) {
      await requireCapacity(this.#fly, this.#org, ref.region, spec)
      await ensureApp(this.#fly, this.#org, this.#deployment, ref.app, ref.serverId as RuntimeKey)
      await ensureFlycast(this.#fly, this.#org, ref.app)
    }
    await progress.step('storage')
    let volume: Volume
    if (from.kind === 'snapshot') {
      const snapshot = decodeSnapshot(from.snapshot)
      if (snapshot.app !== ref.app) throw new Error('That snapshot belongs to another server')
      volume = await createVolume(
        this.#fly,
        ref.app,
        {
          name: VOLUME_NAME,
          region: ref.region,
          size_gb: Math.max(snapshot.sizeGb, spec.storage.sizeGb),
          snapshot_id: snapshot.snapshotId,
        },
        this.snapshotLifetimeDays,
      )
    } else {
      volume = await createVolume(
        this.#fly,
        ref.app,
        {
          name: VOLUME_NAME,
          region: ref.region,
          size_gb: spec.storage.sizeGb,
        },
        this.snapshotLifetimeDays,
      )
      const volumeId = idOf(volume, 'a volume')
      await volumeReady(this.#fly, ref.app, volumeId)
      const job = restoreJob(from.download.url)
      await whenRoom(
        this.#roomWait,
        () => helperJob(this.#fly, this.#deployment, ref.app, ref.region, volumeId, job),
        {
          waiting: () => progress.step('waiting_for_room'),
          refused: () => deleteVolume(this.#fly, ref.app, volumeId),
        },
      )
    }
    const next = await this.#replace(ref, volume, ref.region, spec, progress)
    if (from.kind === 'archive') await clearEarlierWakes(this.#fly, ref.app, idOf(volume, 'a volume'))
    return next
  }

  async relocate(
    handle: RuntimeHandle,
    to: Placement,
    spec: RuntimeSpec,
    progress: ProgressSink,
    from?: SnapshotHandle,
    options: { keepStorage?: boolean } = {},
  ): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    const region = flyRegion(this.#regions, to)
    if (from !== undefined) {
      // The host is gone, and the volume on it: new storage from the snapshot, which Fly keeps
      // off the host, on whichever host in the region has room.
      const snapshot = decodeSnapshot(from)
      if (snapshot.app !== ref.app) throw new Error('That snapshot belongs to another server')
      await requireCapacity(this.#fly, this.#org, region, spec)
      await progress.step('storage')
      const volume = await createVolume(
        this.#fly,
        ref.app,
        {
          name: VOLUME_NAME,
          region,
          size_gb: Math.max(snapshot.sizeGb, spec.storage.sizeGb),
          snapshot_id: snapshot.snapshotId,
        },
        this.snapshotLifetimeDays,
      )
      return this.#replace(ref, volume, region, spec, progress, { hostLost: true, ...options })
    }
    if (region === ref.region) return handle
    const volumeId = requireVolume(ref)
    // Before stopping anything: a move to a full region is refused while the server is untouched.
    await requireCapacity(this.#fly, this.#org, region, spec)
    await progress.step('storage')
    await this.stop(handle)
    const source = await readVolume(this.#fly, ref.app, volumeId)
    const fork = await createVolume(
      this.#fly,
      ref.app,
      {
        name: VOLUME_NAME,
        region,
        size_gb: Math.max(source?.size_gb ?? 0, spec.storage.sizeGb),
        source_volume_id: volumeId,
      },
      this.snapshotLifetimeDays,
    )
    return this.#replace(ref, fork, region, spec, progress)
  }

  /**
   * The snapshot as a tar.gz, packed on a volume made from it by a helper machine, which sends it
   * in one PUT. One larger than a PUT carries waits on that volume while helpers send it in parts,
   * a few to each job.
   */
  async exportSnapshot(
    snapshot: SnapshotHandle,
    target: ArchiveTarget,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const ref = decodeSnapshot(snapshot)
    // Twice the world's size: the archive is written beside the world before it is uploaded.
    const volume = await createVolume(
      this.#fly,
      ref.app,
      {
        name: EXPORT_VOLUME_NAME,
        region: ref.region,
        size_gb: ref.sizeGb * 2,
        snapshot_id: ref.snapshotId,
      },
      this.snapshotLifetimeDays,
    )
    const volumeId = idOf(volume, 'a volume')
    const job = (script: string) =>
      whenRoom(this.#roomWait, () =>
        helperJob(this.#fly, this.#deployment, ref.app, ref.region, volumeId, script),
      )
    try {
      await volumeReady(this.#fly, ref.app, volumeId)
      const [how = '', sha256 = '', size = '0'] = (
        await job(exportJob(target.put, target.maxPutBytes))
      ).split(' ')
      const sizeBytes = Number(size)
      if (how === 'parts') {
        const parts = await target.inParts(sizeBytes, PARTS_PER_JOB)
        try {
          const put: PutPart[] = []
          for (const batch of partBatches(parts, sizeBytes, PARTS_PER_JOB))
            put.push(...partsPut(await job(partsJob(parts, sizeBytes, batch))))
          await parts.complete(put)
        } catch (error) {
          await parts.abort().catch(() => undefined)
          throw error
        }
      }
      return { sha256, sizeBytes }
    } finally {
      // The archive is up: a volume Fly won't let go of yet is the leftover sweep's.
      const sweep = `fly: ${ref.app} keeps export volume ${volumeId} for the leftover sweep`
      await deleteVolume(this.#fly, ref.app, volumeId).catch((error: unknown) => console.warn(sweep, error))
    }
  }

  async exec(handle: RuntimeHandle, command: readonly string[], timeoutSeconds: number): Promise<ExecResult> {
    const ref = decodeHandle(handle)
    return exec(this.#fly, ref.app, requireMachine(ref), command, timeoutSeconds)
  }

  async decommission(handle: RuntimeHandle): Promise<void> {
    const ref = decodeHandle(handle)
    if (ref.machineId === null) return
    await this.stop(handle)
    await destroyMachine(this.#fly, ref.app, ref.machineId)
  }

  /**
   * The machine goes, then the world's volume; the app stays, with its Flycast address and its
   * secrets, and costs nothing. Anything a restore or a move left behind in it goes too, so what
   * is let go is everything that bills. Snapshots can't be deleted through the API: they outlive
   * the volume for its retention (fly.io/docs/volumes/snapshots).
   */
  async release(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const ref = decodeHandle(handle)
    requireOwnApp(ref.app, this.#deployment)
    // The handle's own, then whatever else is there: an app holds one of each at a time, and a
    // few rounds cover what an interrupted restore could have left.
    let machineId = ref.machineId
    for (let round = 0; round < 3 && machineId !== null; round++) {
      await this.stop(encodeHandle({ ...ref, machineId })).catch(() => undefined)
      await destroyMachine(this.#fly, ref.app, machineId)
      machineId = (await minecraftMachine(this.#fly, ref.app))?.id ?? null
    }
    let volumeId = ref.volumeId ?? (await dataVolume(this.#fly, ref.app))?.id ?? null
    const deleted = new Set<string>()
    for (let round = 0; round < 3 && volumeId !== null; round++) {
      await deleteVolume(this.#fly, ref.app, volumeId)
      deleted.add(volumeId)
      volumeId = (await dataVolume(this.#fly, ref.app, deleted))?.id ?? null
    }
    await clearExports(this.#fly, ref.app)
    if (machineId !== null || volumeId !== null)
      throw new Error(`${ref.app} still holds a machine or a volume after letting them go`)
    return encodeHandle({ ...ref, machineId: null, volumeId: null })
  }

  /**
   * Server machines no handle names, helpers past their lifetime, and then world and export volumes
   * no machine mounts, beside the one the handle names (or none, for a world resting in the archive
   * store) and those `kept` handles name.
   */
  async clearLeftovers(
    handle: RuntimeHandle,
    worldElsewhere: boolean,
    kept: readonly RuntimeHandle[] = [],
  ): Promise<readonly string[]> {
    const ref = decodeHandle(handle)
    requireOwnApp(ref.app, this.#deployment)
    const keep = [...(worldElsewhere ? [] : [ref.volumeId]), ...kept.map((k) => decodeHandle(k).volumeId)]
    const machines = [ref.machineId, ...kept.map((k) => decodeHandle(k).machineId)]
    const destroyed = await destroyStrays(this.#fly, ref.app, { machines, volumes: keep }, Date.now())
    return [...destroyed, ...(await deleteLeftoverVolumes(this.#fly, ref.app, keep))]
  }

  async destroy(target: RuntimeKey | RuntimeHandle): Promise<void> {
    const app = isFlyHandle(target)
      ? decodeHandle(target).app
      : appName(this.#deployment, target as RuntimeKey)
    // Never another deployment's app, whatever a caller passes.
    requireOwnApp(app, this.#deployment)
    await deleteApp(this.#fly, app)
  }

  async observe(handle: RuntimeHandle): Promise<RuntimeObservation> {
    const ref = decodeHandle(handle)
    if (ref.machineId === null) return { state: 'absent', at: new Date() }
    return observationOf(await readMachine(this.#fly, ref.app, ref.machineId))
  }

  observeChanged(since: Date) {
    return changedSince(this.#fly, this.#org, this.#deployment, since)
  }

  isPlaced(handle: RuntimeHandle, placement: Placement): boolean {
    return decodeHandle(handle).region === this.#regions[placement.regionKey]
  }

  sameCompute(a: RuntimeHandle, b: RuntimeHandle): boolean {
    const [first, second] = [decodeHandle(a), decodeHandle(b)]
    return first.app === second.app && first.machineId === second.machineId
  }

  inventory() {
    return inventory(this.#fly, this.#org, this.#deployment)
  }

  /**
   * The app's Flycast address: it survives restore and relocate, and both the edge and the
   * control plane reach it on the organization's default network.
   */
  endpoint(handle: RuntimeHandle, port: string, _audience: Audience): Endpoint {
    const ref = decodeHandle(handle)
    const number = ref.ports[port]
    if (number === undefined) throw new Error(`This runtime exposes no port named ${port}`)
    return { host: `${ref.app}.flycast`, port: number }
  }

  async tag(servers: ReadonlyMap<RuntimeKey, RuntimeTags>): Promise<number> {
    return tagMachines(this.#fly, this.#org, this.#deployment, servers)
  }

  prices(handle: RuntimeHandle, size: { memoryMb: number; storageGb: number }): RuntimePrices {
    return pricesOf(handle, size)
  }

  locate(handle: RuntimeHandle): RuntimeLocation {
    const ref = decodeHandle(handle)
    return {
      names: [
        { label: 'App', value: ref.app },
        ...(ref.machineId === null ? [] : [{ label: 'Machine', value: ref.machineId }]),
        ...(ref.volumeId === null ? [] : [{ label: 'Volume', value: ref.volumeId }]),
        ...(ref.region === '' ? [] : [{ label: 'Region', value: ref.region }]),
      ],
      link: `https://fly.io/apps/${ref.app}/machines`,
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────

  /** The machine it replaces, or updates, hands on its tags. */
  #config(key: string, spec: RuntimeSpec, volumeId: string, from: Machine | null): MachineConfig {
    return machineConfig(spec, volumeId, {
      deployment: this.#deployment,
      server: key,
      tags: heldTags(from?.config?.metadata),
    })
  }

  /**
   * Restore and relocate: a new machine on the new volume, made before the old one is stopped, so
   * a server that waits for room to make it keeps running meanwhile; then the old machine and the
   * old volume go. The Flycast address belongs to the app, so the edge's route does not change.
   * With the old host lost there is nothing to stop, and clearing what it held is left to Fly when
   * it can't be done now. `keepStorage`: the old volume stays, a full copy of the world. Once the
   * new handle is saved, any other server machine in the app goes too, with its volume: one an
   * earlier try made before it stopped, which a wake would otherwise boot.
   */
  async #replace(
    ref: FlyRef,
    volume: Volume,
    region: string,
    spec: RuntimeSpec,
    progress: ProgressSink,
    options: { hostLost?: boolean; keepStorage?: boolean } = {},
  ): Promise<RuntimeHandle> {
    await progress.step('compute')
    const volumeId = idOf(volume, 'a volume')
    // A lost host's machine may still be described, which is all its tags need; if not, the next
    // tagging writes them again.
    const old =
      ref.machineId === null
        ? null
        : await readMachine(this.#fly, ref.app, ref.machineId).catch((error: unknown) =>
            options.hostLost ? null : Promise.reject(error),
          )
    const wasRunning = !options.hostLost && old?.state === 'started'
    const secretsVersion = await setSecrets(this.#fly, ref.app, spec.secrets)
    const config = this.#config(ref.serverId, spec, volumeId, old)
    const name = `minecraft-${Date.now().toString(36)}`
    const make = () => createMachine(this.#fly, ref.app, region, config, secretsVersion, name)
    const machine = await whenRoom(this.#roomWait, make, {
      waiting: () => progress.step('waiting_for_room'),
      refused: () => deleteVolume(this.#fly, ref.app, volumeId),
    })
    if (!options.hostLost) await this.stop(encodeHandle(ref))
    const next = encodeHandle({
      ...ref,
      region,
      volumeId,
      machineId: idOf(machine, 'a machine'),
      ports: portsOf(spec),
    })
    await progress.handle(next)
    await volumeReady(this.#fly, ref.app, volumeId)
    const leftBehind = options.hostLost ? () => undefined : (error: unknown) => Promise.reject(error)
    if (ref.machineId !== null) await destroyMachine(this.#fly, ref.app, ref.machineId).catch(leftBehind)
    if (ref.volumeId !== null && !options.keepStorage)
      await deleteVolume(this.#fly, ref.app, ref.volumeId).catch(leftBehind)
    await clearOtherServers(this.#fly, ref.app, idOf(machine, 'a machine'), [volumeId, ref.volumeId])
    if (wasRunning) await this.start(next)
    return next
  }
}

// ─── pure helpers ─────────────────────────────────────────────────────────────────────────────

function requireMachine(ref: FlyRef): string {
  if (ref.machineId === null) throw new Error('This server has no machine; it was decommissioned')
  return ref.machineId
}

/** The machine the storage a server holds names, by id: its handle's. */
function machineOf(storage: HeldStorage): string | null {
  return storage.held != null && isFlyHandle(storage.held) ? decodeHandle(storage.held).machineId : null
}

/** The volumes the storage a server holds names, by id: what its handle names, and what is kept. */
function volumesOf(storage: HeldStorage): { held: string | null; kept: string[] } {
  const volume = (handle: RuntimeHandle) => (isFlyHandle(handle) ? decodeHandle(handle).volumeId : null)
  return {
    held: storage.held == null ? null : volume(storage.held),
    kept: (storage.kept ?? []).flatMap((handle) => volume(handle) ?? []),
  }
}

function requireVolume(ref: FlyRef): string {
  if (ref.volumeId === null) throw new Error('This server has no volume')
  return ref.volumeId
}
