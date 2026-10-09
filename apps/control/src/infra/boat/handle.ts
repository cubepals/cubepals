import { z } from 'zod'
import type { RuntimeHandle, SnapshotHandle } from '../../app/ports/runtime.ts'

/** What a Boat handle names. Nothing outside infra/boat ever reads one. */
const BoatRef = z.object({
  deployment: z.string().min(1),
  serverId: z.string().min(1),
  /** Null once released: the world rests in the archive store, and no sandbox holds anything. */
  sandboxId: z.string().min(1).nullable(),
  /**
   * The sandbox's public address when this handle was issued. It changes on every resume, and is
   * only the server's own while the server runs.
   */
  address: z.string().min(1).nullable(),
  /** Port name → port, the same inside the container and on the sandbox's address. */
  ports: z.record(z.string(), z.number().int()),
  /** The TCP ports the edge reaches, which the sandbox's firewall lets in. */
  open: z.array(z.number().int()),
  /**
   * The sandbox a released server had last. Its next one is made under an idempotency key naming
   * it, so every sandbox a server has gets a key of its own, and Boat never answers with one it
   * deleted.
   */
  previous: z.string().min(1).nullable(),
})
export type BoatRef = z.infer<typeof BoatRef>

/** A Blockly snapshot on Boat: an archive of the world, kept inside its server's sandbox. */
const BoatSnapshotRef = z.object({
  sandboxId: z.string().min(1),
  file: z.string().regex(/^[0-9a-z-]+\.tar\.gz$/),
})
export type BoatSnapshotRef = z.infer<typeof BoatSnapshotRef>

const HANDLE = 'boat:v1:'
const SNAPSHOT = 'boat-snapshot:v1:'

const pack = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const unpack = (text: string): unknown => JSON.parse(Buffer.from(text, 'base64url').toString())

export function encodeHandle(ref: BoatRef): RuntimeHandle {
  return `${HANDLE}${pack(BoatRef.parse(ref))}` as RuntimeHandle
}

export function decodeHandle(handle: string): BoatRef {
  if (!handle.startsWith(HANDLE)) throw new Error('This handle was not issued by the Boat runtime')
  return BoatRef.parse(unpack(handle.slice(HANDLE.length)))
}

export const isBoatHandle = (value: string) => value.startsWith(HANDLE)

export const isBoatSnapshot = (value: string) => value.startsWith(SNAPSHOT)

export function encodeSnapshot(ref: BoatSnapshotRef): SnapshotHandle {
  return `${SNAPSHOT}${pack(BoatSnapshotRef.parse(ref))}` as SnapshotHandle
}

export function decodeSnapshot(snapshot: string): BoatSnapshotRef {
  if (!snapshot.startsWith(SNAPSHOT)) throw new Error('This snapshot was not taken by the Boat runtime')
  return BoatSnapshotRef.parse(unpack(snapshot.slice(SNAPSHOT.length)))
}
