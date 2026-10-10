// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fly machines: read, found by role, made, changed under their lease, destroyed, waited on and
 * run commands in. It decides neither when a machine changes nor in what order with its volume;
 * those are the verbs in `fly-runtime.ts`. What a machine's state means is `observation.ts`.
 */

import { z } from 'zod'
import type { ExecResult } from '../../../app/ports/runtime.ts'
import type { FlyClient, FlySchemas } from '../client.ts'
import { META } from '../machine-config.ts'
import { idOf, launched, must, succeeded } from './responses.ts'

type Machine = FlySchemas['Machine']
type MachineConfig = FlySchemas['fly.MachineConfig']

const LEASE_TTL_SECONDS = 120
const MACHINE_GONE = new Set(['destroyed', 'destroying'])
/**
 * A machine just made or changed stays here while Fly prepares it (its image onto the host), and
 * one asked to stop while it stops; Fly refuses to start it until it has settled: 412, "unable to
 * start machine from current state".
 */
const SETTLING = new Set(['created', 'replacing', 'stopping'])
/** A cold host pulls the Minecraft image first, which took 70 s on staging. */
const SETTLE_SECONDS = 600
/**
 * How Fly refuses a start that has only to wait: the machine is still settling, or Fly is still
 * finishing a stop it already reports done ("machine still active, refusing to start", staging,
 * 2026-10-07).
 */
const NOT_YET =
  /refusing to start|unable to start machine from current state: '(?:created|replacing|stopping)'/
/**
 * Fly destroys a machine in the background, and its volume stays bound to it until it has: on
 * staging, a volume deleted straight after was refused in 3 of 6 rests (docs/metrics.md).
 */
const DESTROY_SECONDS = 60
/**
 * How Fly refuses a machine on a volume another machine still holds. A wake's helper fills the
 * new volume and is destroyed, and Fly can go on holding the volume after the helper is gone:
 * "volume already claimed by machine" naming no machine, its id all NUL bytes (production,
 * 2026-10-11), which failed the wake.
 */
const CLAIMED = /already claimed/i
/** How long a new machine waits for Fly to let go of its volume, past the helper's own destroy. */
const CLAIM_SECONDS = 180

// The spec says a flat Lease; flyctl reads { status, data: Lease }. Accept either until a live
// machine settles it (docs/dependency-audit.md).
const LeaseBody = z.union([
  z.object({ nonce: z.string().min(1) }),
  z.object({ data: z.object({ nonce: z.string().min(1) }) }),
])

export async function minecraftMachine(fly: FlyClient, app: string): Promise<Machine | null> {
  const listed = await fly.GET('/v1/apps/{app_name}/machines', {
    params: { path: { app_name: app } },
  })
  if (listed.response.status === 404) return null
  return (
    must(listed, 'listing machines').find(
      (m) => m.config?.metadata?.[META.role] === 'minecraft' && !MACHINE_GONE.has(m.state ?? ''),
    ) ?? null
  )
}

export async function readMachine(fly: FlyClient, app: string, machineId: string): Promise<Machine | null> {
  const found = await fly.GET('/v1/apps/{app_name}/machines/{machine_id}', {
    params: { path: { app_name: app, machine_id: machineId } },
  })
  if (found.response.status === 404) return null
  const machine = must(found, 'reading the machine')
  return MACHINE_GONE.has(machine.state ?? '') ? null : machine
}

/**
 * A new machine on the volume its config mounts. While Fly says another machine still holds that
 * volume, the holder is looked for: a live server machine of this deployment is the one being
 * made, and is used as it is; a helper left over is destroyed; anything else, and a holder Fly no
 * longer lists, is waited out. After three minutes Fly's refusal stands. No volume is deleted here.
 */
export async function createMachine(
  fly: FlyClient,
  app: string,
  region: string,
  config: MachineConfig,
  secretsVersion: number | undefined,
  name: string,
): Promise<Machine> {
  const volumeId = config.mounts?.[0]?.volume
  const deadline = Date.now() + CLAIM_SECONDS * 1000
  for (;;) {
    const created = await fly.POST('/v1/apps/{app_name}/machines', {
      params: { path: { app_name: app } },
      body: {
        name,
        region,
        config,
        skip_launch: true,
        ...(secretsVersion === undefined ? {} : { min_secrets_version: secretsVersion }),
      },
    })
    const claimed =
      volumeId !== undefined &&
      created.response.status === 412 &&
      CLAIMED.test(JSON.stringify(created.error ?? ''))
    if (!claimed || Date.now() > deadline) return launched(created, 'creating the machine')
    const adopted = await clearClaim(fly, app, volumeId, config.metadata?.[META.deployment])
    if (adopted !== null) return adopted
  }
}

/**
 * One step towards a volume Fly says is claimed: this deployment's live server machine on it, to
 * be used as it is; else null, once a helper of its left on the volume is destroyed, or a second
 * has passed for whatever else holds it.
 */
async function clearClaim(
  fly: FlyClient,
  app: string,
  volumeId: string,
  deployment: string | undefined,
): Promise<Machine | null> {
  const listed = must(
    await fly.GET('/v1/apps/{app_name}/machines', { params: { path: { app_name: app } } }),
    'listing machines',
  )
  const holder = listed.find(
    (m) => m.state !== 'destroyed' && (m.config?.mounts ?? []).some((mount) => mount.volume === volumeId),
  )
  const metadata = holder?.config?.metadata
  const role = metadata?.[META.deployment] === deployment ? metadata?.[META.role] : undefined
  if (holder !== undefined && role === 'minecraft' && !MACHINE_GONE.has(holder.state ?? '')) return holder
  if (holder !== undefined && role === 'helper')
    await destroyMachine(fly, app, idOf(holder, 'a helper machine'))
  else await sleep(1000)
  return null
}

export async function updateMachine(
  fly: FlyClient,
  deployment: string,
  app: string,
  machineId: string,
  config: MachineConfig,
  secretsVersion: number | undefined,
  skipLaunch: boolean,
): Promise<Machine> {
  return withLease(fly, deployment, app, machineId, async (nonce) =>
    launched(
      await fly.POST('/v1/apps/{app_name}/machines/{machine_id}', {
        params: { path: { app_name: app, machine_id: machineId } },
        headers: { 'fly-machine-lease-nonce': nonce },
        body: {
          config,
          skip_launch: skipLaunch,
          ...(secretsVersion === undefined ? {} : { min_secrets_version: secretsVersion }),
        },
      }),
      'updating the machine',
    ),
  )
}

/**
 * Returns once Fly has finished destroying it, so its volume is free, or after a minute; a volume
 * still bound then is waited for by `deleteVolume`.
 */
export async function destroyMachine(fly: FlyClient, app: string, machineId: string): Promise<void> {
  succeeded(
    await fly.DELETE('/v1/apps/{app_name}/machines/{machine_id}', {
      params: { path: { app_name: app, machine_id: machineId }, query: { force: true } },
    }),
    'destroying the machine',
    404,
  )
  const deadline = Date.now() + DESTROY_SECONDS * 1000
  while (Date.now() < deadline) {
    const found = await fly.GET('/v1/apps/{app_name}/machines/{machine_id}', {
      params: { path: { app_name: app, machine_id: machineId } },
    })
    if (found.response.status === 404 || found.data?.state === 'destroyed') return
    const waited = await fly.GET('/v1/apps/{app_name}/machines/{machine_id}/wait', {
      params: { path: { app_name: app, machine_id: machineId }, query: { state: 'destroyed', timeout: 10 } },
    })
    if (!waited.response.ok && waited.response.status !== 408) await sleep(1000)
  }
}

/** Changes to a machine hold its lease, so two workers never fight over one machine. */
export async function withLease<T>(
  fly: FlyClient,
  deployment: string,
  app: string,
  machineId: string,
  work: (nonce: string) => Promise<T>,
): Promise<T> {
  const taken = LeaseBody.parse(
    must(
      await fly.POST('/v1/apps/{app_name}/machines/{machine_id}/lease', {
        params: { path: { app_name: app, machine_id: machineId } },
        body: { ttl: LEASE_TTL_SECONDS, description: `blockly ${deployment}` },
      }),
      'taking the machine lease',
    ),
  )
  const nonce = 'nonce' in taken ? taken.nonce : taken.data.nonce
  try {
    return await work(nonce)
  } finally {
    await fly
      .DELETE('/v1/apps/{app_name}/machines/{machine_id}/lease', {
        params: {
          path: { app_name: app, machine_id: machineId },
          header: { 'fly-machine-lease-nonce': nonce },
        },
      })
      .catch(() => undefined)
  }
}

/**
 * Started once Fly has settled it, and asked again while Fly refuses only because it hasn't yet. A
 * refused start used to fail the operation, whose retries backed off well past the moment it was
 * ready (on staging, 40 s of a first start spent waiting on nothing, and a start straight after a
 * stop came up 123 s later). One already started or starting is left as it is.
 */
export async function startMachine(fly: FlyClient, app: string, machineId: string): Promise<void> {
  const deadline = Date.now() + SETTLE_SECONDS * 1000
  for (;;) {
    const machine = await settled(fly, app, machineId)
    if (machine === null) throw new Error('The machine is gone')
    if (machine.state === 'started' || machine.state === 'starting') return
    const started = await fly.POST('/v1/apps/{app_name}/machines/{machine_id}/start', {
      params: { path: { app_name: app, machine_id: machineId } },
    })
    const notYet = started.response.status === 412 && NOT_YET.test(JSON.stringify(started.error ?? ''))
    if (!notYet || Date.now() > deadline) {
      launched(started, 'starting the machine')
      return
    }
    await sleep(1000)
  }
}

/** The machine once Fly has finished preparing it, or stopping it. */
async function settled(fly: FlyClient, app: string, machineId: string): Promise<Machine | null> {
  const deadline = Date.now() + SETTLE_SECONDS * 1000
  for (;;) {
    const machine = await readMachine(fly, app, machineId)
    if (machine === null || !SETTLING.has(machine.state ?? '')) return machine
    if (Date.now() > deadline) throw new Error('Fly took too long to settle the machine')
    // A long poll: answers when it is ready, or 408 after ten seconds. Anything else answers at
    // once, and a second's pause keeps that from becoming a loop of requests.
    const waited = await fly.GET('/v1/apps/{app_name}/machines/{machine_id}/wait', {
      params: { path: { app_name: app, machine_id: machineId }, query: { state: 'stopped', timeout: 10 } },
    })
    if (!waited.response.ok && waited.response.status !== 408) await sleep(1000)
  }
}

export async function waitFor(
  fly: FlyClient,
  app: string,
  machineId: string,
  state: 'started' | 'stopped',
  withinSeconds: number,
): Promise<void> {
  const deadline = Date.now() + withinSeconds * 1000
  while (Date.now() < deadline) {
    const machine = await readMachine(fly, app, machineId)
    if (machine === null || machine.state === state) return
    await fly.GET('/v1/apps/{app_name}/machines/{machine_id}/wait', {
      params: { path: { app_name: app, machine_id: machineId }, query: { state, timeout: 10 } },
    })
  }
  throw new Error(`The machine did not reach ${state} in time`)
}

export async function exec(
  fly: FlyClient,
  app: string,
  machineId: string,
  command: readonly string[],
  timeoutSeconds: number,
): Promise<ExecResult> {
  const result = must(
    await fly.POST('/v1/apps/{app_name}/machines/{machine_id}/exec', {
      params: { path: { app_name: app, machine_id: machineId } },
      body: { command: [...command], timeout: timeoutSeconds },
    }),
    'running a command',
  )
  return { exitCode: result.exit_code ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
