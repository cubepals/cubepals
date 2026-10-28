// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import type { ProgressSink, RuntimeSpec, RuntimeTags } from '../../app/ports/runtime.ts'
import type { FlySchemas } from './client.ts'

type Machine = FlySchemas['Machine']
type MachineConfig = FlySchemas['fly.MachineConfig']
type MachineGuest = FlySchemas['fly.MachineGuest']

export const META = {
  deployment: 'blockly_deployment',
  server: 'blockly_server',
  role: 'blockly_role',
  volume: 'blockly_volume',
  ports: 'blockly_ports',
  digest: 'blockly_spec_digest',
  resumes: 'blockly_resumes_on',
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
 * throttled (50–92% steal) and crashed; one core up to 3 GB, two at 4 GB, four from 6 GB, where
 * twenty players or a medium or heavy pack generate terrain on the extra cores, and eight past 8 GB.
 * A hundred players fighting held 20 TPS on eight cores and fell to 15 on four, whatever the
 * memory. Where a count comes with more memory than the
 * size asks for, the server keeps the size's heap and the rest is page cache.
 */
export function guestFor(memoryMb: number): MachineGuest {
  const cores = memoryMb <= 3072 ? 1 : memoryMb <= 4096 ? 2 : memoryMb <= 8192 ? 4 : 8
  const cpus = PERFORMANCE_CPUS.find((count) => count >= cores && count * MB_PER_CPU.most >= memoryMb)
  if (cpus === undefined) throw new Error(`No performance Fly machine holds ${memoryMb} MB`)
  return {
    cpu_kind: 'performance',
    cpus,
    memory_mb: Math.max(cpus * MB_PER_CPU.least, Math.ceil(memoryMb / MB_STEP) * MB_STEP),
  }
}

/** The spec's, secrets included; not its `resumesOn`, which the machine keeps beside it. */
const specDigest = ({ resumesOn: _resumesOn, ...spec }: RuntimeSpec) =>
  createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 32)

/**
 * The volume a machine asleep, or going to sleep, on `spec` mounts: on exactly it, secrets
 * included, or on one its `resumesOn` says it may wake on as it slept. A start resumes it as
 * it was, once it is asleep, with nothing to post or change first; the rest of `spec` waits for
 * its next boot. Null for a machine awake, or asleep on anything else, whose new configuration must
 * boot.
 */
export function asleepOn(machine: Machine | null, spec: RuntimeSpec): string | null {
  const asleep = isAsleep(machine)
  const metadata = machine?.config?.metadata ?? {}
  const same =
    metadata[META.digest] === specDigest(spec) ||
    (spec.resumesOn !== undefined && metadata[META.resumes] === spec.resumesOn)
  if (!asleep || !same) return null
  return machine?.config?.mounts?.[0]?.volume ?? null
}

/** Whether a machine is asleep with its memory, or on its way there. */
const isAsleep = (machine: Machine | null): boolean =>
  machine?.state === 'suspended' || machine?.state === 'suspending'

/**
 * A start's step, `resuming` a machine asleep on what it is asked to run (`asleepOn`) or `booting`,
 * and for a boot the reason, kept on the operation's record (`RuntimeMark`).
 */
export async function startStep(progress: ProgressSink, existing: Machine | null, asleep: string | null) {
  if (asleep === null)
    await progress.mark?.(existing === null ? 'no_compute' : isAsleep(existing) ? 'other_spec' : 'not_asleep')
  await progress.step(asleep === null ? 'booting' : 'resuming')
}

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
      ...(spec.resumesOn === undefined ? {} : { [META.resumes]: spec.resumesOn }),
    },
  }
}
