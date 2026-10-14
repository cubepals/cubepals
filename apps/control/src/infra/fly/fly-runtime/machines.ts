// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fly machines: read, found by role, made, changed under their lease, stopped, suspended,
 * destroyed, waited on and run commands in. It decides neither when a machine changes nor in what order with its volume;
 * those are the verbs in `fly-runtime.ts`. What a machine's state means is `observation.ts`.
 */

import { z } from 'zod'
import type { ExecResult } from '../../../app/ports/runtime.ts'
import type { FlyClient, FlySchemas } from '../client.ts'
import { META } from '../machine-config.ts'
import { saysClaimed, saysNotYet, saysReplacing } from '../refusals.ts'
import { idOf, launched, must, succeeded } from './responses.ts'

type Machine = FlySchemas['Machine']
type MachineConfig = FlySchemas['fly.MachineConfig']

const LEASE_TTL_SECONDS = 120
const MACHINE_GONE = new Set(['destroyed', 'destroying'])
/**
 * A machine just made or changed stays here while Fly prepares it (its image onto the host), one
 * asked to stop while it stops, and one asked to suspend while it writes its memory out; Fly
 * refuses to start it until it has settled: 412, "unable to start machine from current state".
 */
const SETTLING = new Set(['created', 'replacing', 'updating', 'stopping', 'suspending'])
/** Fly putting an update in place: a new version of the machine made, the old one's run replaced. */
const REPLACING = new Set(['replacing', 'updating'])
/** Asleep with its memory kept, or on its way there. */
const ASLEEP = new Set(['suspending', 'suspended'])
/** A workload a stop ends: running, on its way up or down, or asleep with its memory kept. */
const STOPPABLE = new Set(['started', 'starting', 'stopping', 'replacing', 'suspending', 'suspended'])
/**
 * How long a suspend may take to write the machine's memory out: 5 to 17 s at 2 and 3 GB, growing
 * with the memory it holds.
 */
const SUSPEND_SECONDS = 120
/** A cold host pulls the Minecraft image first, which took 70 s on staging. */
const SETTLE_SECONDS = 600
/**
 * Fly destroys a machine in the background, and its volume stays bound to it until it has: on
 * staging, a volume deleted straight after was refused in 3 of 6 rests.
 */
const DESTROY_SECONDS = 60
/**
 * How long a new machine waits for Fly to let go of its volume, past the helper's own destroy. A
 * wake's helper fills the new volume and is destroyed, and Fly can go on holding the volume after
 * the helper is gone (`saysClaimed`), which failed a wake on production.
 */
const CLAIM_SECONDS = 180
/**
 * How long a machine Fly answers for as gone, and lists nowhere either, is looked for before it
 * counts as gone.
 */
const GONE_SECONDS = 30

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

/** The server's machine on the volume, whatever its id; null if there is none. */
export async function machineOnVolume(
  fly: FlyClient,
  app: string,
  volumeId: string,
): Promise<Machine | null> {
  const machine = await minecraftMachine(fly, app)
  return machine?.config?.mounts?.some((mount) => mount.volume === volumeId) ? machine : null
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
 * The machine, unless it is gone for good. While Fly replaces a machine's run for an update, it
 * can answer for the machine as gone, 404 or the replaced version's `destroyed` (staging,
 * 2026-10-14: an apply read its machine gone mid-replace, and its going back was refused 409
 * since the replace was still under way). So one read as gone is the one the app lists, while it
 * lists it, and is looked for again for `GONE_SECONDS` while it lists it nowhere, unless the app
 * lists another server machine instead.
 */
export async function readUnlessGone(
  fly: FlyClient,
  app: string,
  machineId: string,
): Promise<Machine | null> {
  const deadline = Date.now() + GONE_SECONDS * 1000
  for (;;) {
    const machine = await readMachine(fly, app, machineId)
    if (machine !== null) return machine
    const listed = await fly.GET('/v1/apps/{app_name}/machines', { params: { path: { app_name: app } } })
    if (listed.response.status === 404) return null
    const live = must(listed, 'listing machines').filter((m) => !MACHINE_GONE.has(m.state ?? ''))
    const found = live.find((m) => m.id === machineId)
    if (found !== undefined) return found
    // Another server machine in its place: this one is gone, replaced by that one.
    const another = live.some((m) => m.config?.metadata?.[META.role] === 'minecraft')
    if (another || Date.now() > deadline) return null
    await sleep(1000)
  }
}

/**
 * The machine once Fly has put an update in place, or null if it is gone. Fly refuses another
 * update meanwhile (`saysReplacing`), and the machine is neither running nor stopped.
 */
export async function afterReplace(
  fly: FlyClient,
  app: string,
  machineId: string,
  withinSeconds = SETTLE_SECONDS,
): Promise<Machine | null> {
  const deadline = Date.now() + withinSeconds * 1000
  for (;;) {
    const machine = await readUnlessGone(fly, app, machineId)
    if (machine === null || !REPLACING.has(machine.state ?? '')) return machine
    if (Date.now() > deadline) throw new Error('Fly took too long to put the update in place')
    // A long poll, as `settled`'s: a replace ends with the machine started, or stopped.
    const waited = await fly.GET('/v1/apps/{app_name}/machines/{machine_id}/wait', {
      params: { path: { app_name: app, machine_id: machineId }, query: { state: 'started', timeout: 10 } },
    })
    if (!waited.response.ok && waited.response.status !== 408) await sleep(1000)
  }
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
    const claimed = volumeId !== undefined && created.response.status === 412 && saysClaimed(created.error)
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

/**
 * A new config for the machine, under its lease. One Fly refuses because an update before it is
 * still being put in place is asked again once that one is, the lease held meanwhile, so no other
 * worker's change comes between.
 */
export async function updateMachine(
  fly: FlyClient,
  deployment: string,
  app: string,
  machineId: string,
  config: MachineConfig,
  secretsVersion: number | undefined,
  skipLaunch: boolean,
): Promise<Machine> {
  return withLease(fly, deployment, app, machineId, async (nonce) => {
    // Within the lease's life, so the nonce still holds when it is asked again.
    const deadline = Date.now() + (LEASE_TTL_SECONDS - 30) * 1000
    for (;;) {
      const updated = await fly.POST('/v1/apps/{app_name}/machines/{machine_id}', {
        params: { path: { app_name: app, machine_id: machineId } },
        headers: { 'fly-machine-lease-nonce': nonce },
        body: {
          config,
          skip_launch: skipLaunch,
          ...(secretsVersion === undefined ? {} : { min_secrets_version: secretsVersion }),
        },
      })
      const replacing = updated.response.status === 409 && saysReplacing(updated.error)
      const left = (deadline - Date.now()) / 1000
      if (!replacing || left <= 0) return launched(updated, 'updating the machine')
      await afterReplace(fly, app, machineId, left)
    }
  })
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
async function withLease<T>(
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
    // A start straight after a suspend is refused 409 while Fly still writes its memory out.
    const refused = started.response.status === 412 || started.response.status === 409
    const notYet = refused && saysNotYet(started.error)
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
    const machine = await readUnlessGone(fly, app, machineId)
    if (machine === null || !SETTLING.has(machine.state ?? '')) return machine
    if (Date.now() > deadline) throw new Error('Fly took too long to settle the machine')
    // A long poll: answers when it is ready, or 408 after ten seconds. Anything else answers at
    // once, and a second's pause keeps that from becoming a loop of requests.
    const state = machine.state === 'suspending' ? 'suspended' : 'stopped'
    const waited = await fly.GET('/v1/apps/{app_name}/machines/{machine_id}/wait', {
      params: { path: { app_name: app, machine_id: machineId }, query: { state, timeout: 10 } },
    })
    if (!waited.response.ok && waited.response.status !== 408) await sleep(1000)
  }
}

/**
 * Stops a machine's workload under its lease and waits until it has: `gracefully`, with the signal
 * and grace its config gives it; `killed`, at once. A machine asleep is stopped too, which drops
 * the memory Fly kept and runs no shutdown, and one still writing that memory out is let finish
 * first. One with no workload is left as it is.
 */
export async function stopMachine(
  fly: FlyClient,
  deployment: string,
  app: string,
  machineId: string,
  how: 'gracefully' | 'killed',
): Promise<void> {
  const machine = await readMachine(fly, app, machineId)
  if (machine === null || !STOPPABLE.has(machine.state ?? '')) return
  if (machine.state === 'suspending')
    await waitFor(fly, app, machineId, 'suspended', SUSPEND_SECONDS).catch(() => undefined)
  const graceful = machine.config?.stop_config
  await withLease(fly, deployment, app, machineId, async (nonce) =>
    succeeded(
      await fly.POST('/v1/apps/{app_name}/machines/{machine_id}/stop', {
        params: { path: { app_name: app, machine_id: machineId } },
        headers: { 'fly-machine-lease-nonce': nonce },
        body:
          how === 'killed'
            ? { signal: 'SIGKILL', timeout: '1s' }
            : { signal: graceful?.signal, timeout: graceful?.timeout },
      }),
      how === 'killed' ? 'killing the machine' : 'stopping the machine',
    ),
  )
  await waitFor(fly, app, machineId, 'stopped', how === 'killed' ? 60 : seconds(graceful?.timeout) + 30)
}

/**
 * Puts a machine to sleep with Fly's suspend, or, where it isn't running, Fly won't suspend it or
 * `suspend` is off, stops it as `gracefully` does: says which. One already asleep stays asleep.
 */
export async function sleepMachine(
  fly: FlyClient,
  deployment: string,
  app: string,
  machineId: string,
  suspend: boolean,
): Promise<'suspended' | 'stopped'> {
  const state = (await readMachine(fly, app, machineId))?.state ?? ''
  if (state === 'suspended') return 'suspended'
  if (ASLEEP.has(state) || (suspend && state === 'started'))
    if (await suspendMachine(fly, deployment, app, machineId, state)) return 'suspended'
  await stopMachine(fly, deployment, app, machineId, 'gracefully')
  return 'stopped'
}

/**
 * Suspends a started machine under its lease, or lets a suspend already under way finish, and
 * waits until it is asleep: true once it is, false where Fly refused it or it didn't get there,
 * which the caller answers with a stop. A refusal because another suspend got there first is no
 * refusal. Fly's guidance is 2 GB or less; Cubepals' 3 GB suspended every time it was measured,
 * only slower.
 */
async function suspendMachine(
  fly: FlyClient,
  deployment: string,
  app: string,
  machineId: string,
  state: string,
): Promise<boolean> {
  try {
    const refused =
      state === 'started'
        ? await withLease(fly, deployment, app, machineId, async (nonce) => {
            const sent = await fly.POST('/v1/apps/{app_name}/machines/{machine_id}/suspend', {
              params: { path: { app_name: app, machine_id: machineId } },
              headers: { 'fly-machine-lease-nonce': nonce },
            })
            return sent.response.ok ? null : `${sent.response.status} ${JSON.stringify(sent.error ?? '')}`
          }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
        : null
    let now = (await readMachine(fly, app, machineId))?.state ?? 'gone'
    // Refused because another holder of the lease is suspending it this moment: that one will.
    for (let look = 0; refused !== null && now === 'started' && look < 5; look++) {
      await sleep(500)
      now = (await readMachine(fly, app, machineId))?.state ?? 'gone'
    }
    if (refused !== null && !ASLEEP.has(now)) throw new Error(refused)
    if (await untilAsleep(fly, app, machineId)) return true
    throw new Error(`it is ${(await readMachine(fly, app, machineId))?.state ?? 'gone'}`)
  } catch (error) {
    console.warn(
      `fly: ${app} didn't suspend (${error instanceof Error ? error.message : error}); stopping it`,
    )
    return false
  }
}

/**
 * Whether a machine asked to suspend gets there: true once it is suspended, or started again after
 * it was seen suspending, by a wake that came first (staging, 2026-10-11: a start while it was
 * suspending resumed it before this saw it asleep, and a stop then would end the wake). False once
 * it is anything else, or after `SUSPEND_SECONDS`.
 */
async function untilAsleep(fly: FlyClient, app: string, machineId: string): Promise<boolean> {
  const deadline = Date.now() + SUSPEND_SECONDS * 1000
  let suspending = false
  while (Date.now() < deadline) {
    const state = (await readMachine(fly, app, machineId))?.state ?? 'gone'
    if (state === 'suspended' || (suspending && state === 'started')) return true
    if (state === 'suspending') suspending = true
    // A machine the suspend hasn't reached yet still reads started.
    else if (state !== 'started') return false
    const waited = await fly.GET('/v1/apps/{app_name}/machines/{machine_id}/wait', {
      params: { path: { app_name: app, machine_id: machineId }, query: { state: 'suspended', timeout: 2 } },
    })
    if (!waited.response.ok && waited.response.status !== 408) await sleep(500)
  }
  return false
}

export async function waitFor(
  fly: FlyClient,
  app: string,
  machineId: string,
  state: 'started' | 'stopped' | 'suspended',
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

function seconds(timeout: string | undefined): number {
  const match = /^(\d+)s$/.exec(timeout ?? '')
  return match ? Number(match[1]) : 90
}
