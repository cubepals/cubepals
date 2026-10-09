import { z } from 'zod'
import type { RuntimeHandle, SnapshotHandle } from '../../app/ports/runtime.ts'

/** What a Fly handle names. Nothing outside infra/fly ever reads one. */
const FlyRef = z.object({
  deployment: z.string().min(1),
  serverId: z.string().min(1),
  app: z.string().min(1),
  /** Empty only for an app found with nothing placed in it yet. */
  region: z.string(),
  /** Null only for an app found with no volume yet; cleanup still needs to name it. */
  volumeId: z.string().min(1).nullable(),
  /** Null once decommissioned: the volume and its snapshots stay, the machine is gone. */
  machineId: z.string().min(1).nullable(),
  /** Port name → port, the same inside the machine and on its Flycast address. */
  ports: z.record(z.string(), z.number().int()),
})
export type FlyRef = z.infer<typeof FlyRef>

const FlySnapshotRef = z.object({
  app: z.string().min(1),
  region: z.string().min(1),
  volumeId: z.string().min(1),
  snapshotId: z.string().min(1),
  /** A volume restored from the snapshot must be at least this large. */
  sizeGb: z.number().int().positive(),
})
export type FlySnapshotRef = z.infer<typeof FlySnapshotRef>

const HANDLE = 'fly:v1:'
const SNAPSHOT = 'fly-snapshot:v1:'

const pack = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const unpack = (text: string): unknown => JSON.parse(Buffer.from(text, 'base64url').toString())

export function encodeHandle(ref: FlyRef): RuntimeHandle {
  return `${HANDLE}${pack(FlyRef.parse(ref))}` as RuntimeHandle
}

export function decodeHandle(handle: string): FlyRef {
  if (!handle.startsWith(HANDLE)) throw new Error('This handle was not issued by the Fly runtime')
  return FlyRef.parse(unpack(handle.slice(HANDLE.length)))
}

export const isFlyHandle = (value: string) => value.startsWith(HANDLE)

export const isFlySnapshot = (value: string) => value.startsWith(SNAPSHOT)

export function encodeSnapshot(ref: FlySnapshotRef): SnapshotHandle {
  return `${SNAPSHOT}${pack(FlySnapshotRef.parse(ref))}` as SnapshotHandle
}

export function decodeSnapshot(snapshot: string): FlySnapshotRef {
  if (!snapshot.startsWith(SNAPSHOT)) throw new Error('This snapshot was not taken by the Fly runtime')
  return FlySnapshotRef.parse(unpack(snapshot.slice(SNAPSHOT.length)))
}
