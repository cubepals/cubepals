// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import type { RuntimeSpec, RuntimeTags } from '../../app/ports/runtime.ts'
import type { FlySchemas } from './client.ts'

type MachineConfig = FlySchemas['fly.MachineConfig']
type MachineGuest = FlySchemas['fly.MachineGuest']

export const META = {
  deployment: 'blockly_deployment',
  server: 'blockly_server',
  role: 'blockly_role',
  volume: 'blockly_volume',
  ports: 'blockly_ports',
  digest: 'blockly_spec_digest',
} as const

const OWN_KEYS = new Set<string>(Object.values(META))
/** Fly's metadata is for short values; a name longer than this is cut, and still tells servers apart. */
const TAG_VALUE_LENGTH = 100

/**
 * The server's tags as machine metadata beside the adapter's own keys: `owner` is `blockly_owner`,
 * so an operator reads and filters them with the rest. A tag can't take one of the adapter's names.
 */
export function tagMetadata(tags: RuntimeTags): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).map(([name, value]) => {
      const key = `blockly_${name}`
      if (!/^[a-z_]+$/.test(name) || OWN_KEYS.has(key)) throw new Error(`${name} can't be a tag`)
      return [key, value.slice(0, TAG_VALUE_LENGTH)]
    }),
  )
}

/** The tags a machine holds: its `blockly_` metadata that isn't the adapter's own. */
export const heldTags = (metadata: Readonly<Record<string, string>> | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => key.startsWith('blockly_') && !OWN_KEYS.has(key)),
  )

/** Port names and numbers as one metadata value: `game=25565,rcon=25575`. */
const portsValue = (ports: Readonly<Record<string, number>>) =>
  Object.entries(ports)
    .map(([name, port]) => `${name}=${port}`)
    .join(',')
export const parsePorts = (value: string | undefined): Record<string, number> =>
  Object.fromEntries(
    (value ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => {
        const [name = '', port = '0'] = pair.split('=')
        return [name, Number(port)]
      }),
  )
export const portsOf = (spec: RuntimeSpec) => Object.fromEntries(spec.ports.map((p) => [p.name, p.port]))

/**
 * Performance CPUs come in these counts, each with 2 to 8 GB. Memory goes in 1 GB steps, the
 * step flyctl checks for them (internal/machine/update.go, 2026-09); Fly's sizing guide says 2 GB
 * and its API reference 256 MB, and a first run on Fly settles which.
 */
const PERFORMANCE_CPUS = [1, 2, 4, 8, 16] as const
const MB_PER_CPU = { least: 2048, most: 8192 }
const MB_STEP = 1024

/**
 * A Minecraft server's machine, as the capacity research sized them (docs/minecraft-capacity-
 * research.md, Representative profiles): performance CPUs only, since every shared size was
 * throttled (50–92% steal) and crashed; one core up to 3 GB, two at 4 GB, and four from 6 GB,
 * where twenty players or a medium or heavy pack generate terrain on the extra cores. Where a count
 * comes with more memory than the size asks for, the server keeps the size's heap and the rest is
 * page cache.
 */
export function guestFor(memoryMb: number): MachineGuest {
  const cores = memoryMb <= 3072 ? 1 : memoryMb <= 4096 ? 2 : 4
  const cpus = PERFORMANCE_CPUS.find((count) => count >= cores && count * MB_PER_CPU.most >= memoryMb)
  if (cpus === undefined) throw new Error(`No performance Fly machine holds ${memoryMb} MB`)
  return {
    cpu_kind: 'performance',
    cpus,
    memory_mb: Math.max(cpus * MB_PER_CPU.least, Math.ceil(memoryMb / MB_STEP) * MB_STEP),
  }
}

const specDigest = (spec: RuntimeSpec) =>
  createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 32)

/**
 * A RuntimeSpec as a Fly machine. Every port is a raw TCP or UDP service on the app's Flycast
 * address; the platform never starts or stops the machine by itself, so power has one writer.
 * Secrets travel as app secrets, never in the config. A config replaces the machine's metadata
 * whole, so the tags it held (`heldTags`) come along; the digest never sees them.
 */
export function machineConfig(
  spec: RuntimeSpec,
  volumeId: string,
  metadata: { deployment: string; server: string; tags?: Readonly<Record<string, string>> },
): MachineConfig {
  return {
    image: spec.image,
    ...(spec.entrypoint === undefined ? {} : { init: { entrypoint: [...spec.entrypoint] } }),
    env: { ...spec.env },
    guest: guestFor(spec.resources.memoryMb),
    mounts: [{ volume: volumeId, path: spec.storage.mountPath }],
    services: spec.ports.map((port) => ({
      protocol: port.protocol,
      internal_port: port.port,
      ports: [{ port: port.port }],
      autostart: false,
      autostop: 'off',
    })),
    restart: { policy: 'on-failure', max_retries: 3 },
    stop_config: { signal: spec.stop.signal, timeout: `${spec.stop.timeoutSeconds}s` },
    auto_destroy: false,
    metadata: {
      ...metadata.tags,
      [META.deployment]: metadata.deployment,
      [META.server]: metadata.server,
      [META.role]: 'minecraft',
      [META.volume]: volumeId,
      [META.ports]: portsValue(portsOf(spec)),
      [META.digest]: specDigest(spec),
    },
  }
}
