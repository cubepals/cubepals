// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { RuntimeHandle, SnapshotHandle } from '../../app/ports/runtime.ts'

/**
 * What a Docker handle holds. Only this adapter reads it; everyone else stores the string.
 * Ports record both sides so `endpoint` stays pure: container port for the edge on the game
 * network, host port for a control plane running on the host.
 */
export interface DockerRef {
  deployment: string
  serverId: string
  container: string
  volume: string
  ports: Record<string, { container: number; host: number | null }>
}

const PREFIX = 'docker:v1:'

export function encodeHandle(ref: DockerRef): RuntimeHandle {
  return `${PREFIX}${Buffer.from(JSON.stringify(ref)).toString('base64url')}` as RuntimeHandle
}

export const isHandle = (value: string) => value.startsWith(PREFIX)

export function decodeHandle(handle: string): DockerRef {
  if (!handle.startsWith(PREFIX)) throw new Error('This handle was not issued by the Docker runtime')
  const ref = JSON.parse(Buffer.from(handle.slice(PREFIX.length), 'base64url').toString()) as DockerRef
  if (!ref.container || !ref.volume || !ref.serverId) throw new Error('Malformed Docker handle')
  return ref
}

const SNAPSHOT_PREFIX = 'docker-snap:v1:'

export const encodeSnapshot = (volume: string) => `${SNAPSHOT_PREFIX}${volume}` as SnapshotHandle

export const isSnapshot = (value: string) => value.startsWith(SNAPSHOT_PREFIX)

export function decodeSnapshot(handle: string): string {
  if (!handle.startsWith(SNAPSHOT_PREFIX))
    throw new Error('This snapshot was not issued by the Docker runtime')
  return handle.slice(SNAPSHOT_PREFIX.length)
}
