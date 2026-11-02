// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One isolated boot of an exact configuration through the ordinary runtime, artifact, readiness
 * and installation-check ports. No player world, access record or account secrets are attached.
 * Deterministic loader failures block a plan; unavailable infrastructure never proves incompatibility.
 */
import { randomBytes } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import type { Db, ModValidationPlanJson } from '@blockly/db'
import { type Diagnosis, diagnose } from '../../minecraft/diagnosis.ts'
import { installCheck, installProblems, packProblems, parseInstalled } from '../../minecraft/install-check.ts'
import {
  bootedWith,
  bootMismatch,
  namesWhatStarted,
  notLoaded,
  saysNotLoaded,
  saysReady,
} from '../../minecraft/logs.ts'
import { PORT_NAMES, usesProxyProtocol } from '../../minecraft/runtime-spec.ts'

import type { ArtifactLinks } from '../artifacts/links.ts'
import type { BootTimeouts } from '../operations/boot.ts'
import { loadPackContents } from '../packs/persistence.ts'
import { packInstallCheck } from '../packs/startup-evidence.ts'
import type { ReadinessProbe } from '../ports/minecraft.ts'
import type { LogSource } from '../ports/platform.ts'
import { type RuntimeHandle, runtimeKey } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { packOf } from '../servers/revision-reads.ts'
import { validationRevision, validationSpec } from './validation-plan.ts'

export class IncompatibleMods extends Error {}
export class ValidationUnavailable extends Error {}

export class DiagnosedMods extends IncompatibleMods {
  readonly found: Diagnosis
  constructor(found: Diagnosis) {
    super(found.summary)
    this.found = found
  }
}

export interface ValidationRuntimePorts {
  db: Db
  runtime: Runtimes
  probe: ReadinessProbe
  logs: LogSource
  links: Pick<ArtifactLinks, 'forServer'>
  timeouts: BootTimeouts
}

export async function verifyModRuntime(
  ports: ValidationRuntimePorts,
  plan: ModValidationPlanJson,
  id: string,
  keepHandle: (handle: RuntimeHandle) => Promise<void>,
): Promise<{ image: string; log: string[]; installed: string[] }> {
  const signal = AbortSignal.timeout(ports.timeouts.runningMs + ports.timeouts.readyMs)
  let expired: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    expired = () => reject(signal.reason)
    signal.addEventListener('abort', expired, { once: true })
  })
  try {
    return await Promise.race([runCheck(ports, plan, id, keepHandle, signal), timeout])
  } finally {
    if (expired !== undefined) signal.removeEventListener('abort', expired)
  }
}

async function runCheck(
  ports: ValidationRuntimePorts,
  plan: ModValidationPlanJson,
  id: string,
  keepHandle: (handle: RuntimeHandle) => Promise<void>,
  signal: AbortSignal,
): Promise<{ image: string; log: string[]; installed: string[] }> {
  const spec = validationSpec(plan, id, randomBytes(24).toString('hex'), ports.links.forServer(id))
  const handle = await ports.runtime.ensureProvisioned(
    plan.provider,
    runtimeKey(id),
    { regionKey: plan.regionKey },
    spec,
    {
      handle: async (handle) => {
        if (signal.aborted) {
          await ports.runtime.destroy(plan.provider, handle)
          signal.throwIfAborted()
        }
        await keepHandle(handle)
      },
      step: async () => {},
    },
  )
  if (signal.aborted) await ports.runtime.destroy(plan.provider, handle)
  signal.throwIfAborted()
  await keepHandle(handle)
  await ports.runtime.waitRunning(handle, signal).catch(async (error: unknown) => {
    assertCompatible((await ports.logs.recent(handle, 400)).map((line) => line.text))
    throw error
  })
  const log = await waitReady(ports, handle, plan, signal)
  const revision = validationRevision(plan, id)
  const booted = bootedWith(log)
  if (booted.gameVersion === null) throw new Error('The check could not identify the Minecraft version')
  if (missingLoader(plan.loader, booted.loader))
    throw new Error('The check could not identify the mod loader')
  const mismatch = bootMismatch(
    { ...plan, loaderVersion: plan.modpack === null ? plan.loaderVersion : null },
    booted,
  )
  if (mismatch !== null) throw new Error(mismatch)
  const omitted = notLoaded(log, plan.mods)
  const check = installCheck(revision)
  const wrong =
    check === null
      ? []
      : installProblems(
          check,
          parseInstalled(
            (await ports.runtime.exec(handle, check.command, Math.ceil(ports.timeouts.runningMs / SECOND_MS)))
              .stdout,
          ),
        )
  if (plan.modpack !== null) {
    const contents = await loadPackContents(ports.db, plan.modpack.artifact.sha512)
    if (contents === null) throw new Error('The pack’s installation manifest is unavailable')
    const pinned = packOf(plan.modpack)
    const pack = pinned === null ? null : packInstallCheck(contents, pinned)
    if (pack !== null)
      wrong.push(
        ...packProblems(
          pack,
          (await ports.runtime.exec(handle, pack.command, Math.ceil(ports.timeouts.runningMs / SECOND_MS)))
            .stdout,
          true,
        ),
      )
  }
  if (wrong.length > 0)
    throw new Error(`The server did not install the expected files for ${wrong.join(', ')}.`)
  if (omitted.length > 0) throw new IncompatibleMods(`The server left out ${omitted.join(', ')}.`)
  return { image: spec.image, log, installed: installedHashes(plan) }
}

async function waitReady(
  ports: ValidationRuntimePorts,
  handle: RuntimeHandle,
  plan: ModValidationPlanJson,
  signal: AbortSignal,
): Promise<string[]> {
  const proof = new Set<string>()
  while (!signal.aborted) {
    const lines = (await ports.logs.recent(handle, 400)).map((line) => line.text)
    for (const line of lines) if (isProof(line)) proof.add(line)
    if (lines.some(saysReady)) {
      const endpoint = await ports.runtime.endpoint(handle, PORT_NAMES.game, 'control')
      await ports.probe.ping(
        { ...endpoint, proxyProtocol: usesProxyProtocol(validationRevision(plan, '')) },
        signal,
      )
      return [...proof]
    }
    assertCompatible(lines)
    const observed = await ports.runtime.observe(handle)
    if (['crashed', 'stopped', 'absent'].includes(observed.state))
      throw new Error('The compatibility check stopped before its result could be read')
    await new Promise<void>((resolve) => setTimeout(resolve, SECOND_MS))
  }
  throw new Error('The compatibility check timed out; this does not establish a mod conflict')
}

const isProof = (line: string) => namesWhatStarted(line) || saysReady(line) || saysNotLoaded(line)

function installedHashes(plan: ModValidationPlanJson): string[] {
  return [...plan.mods, ...plan.compat, ...(plan.modpack === null ? [] : [plan.modpack])].map(
    (entry) => entry.artifact.sha512,
  )
}

function assertCompatible(lines: string[]): void {
  const failure = diagnose(lines)
  if (failure === null) return
  if (!['mods', 'modpack'].includes(failure.remedy)) throw new Error(failure.summary)
  throw new DiagnosedMods(failure)
}

const missingLoader = (expected: string, actual: string | null) =>
  ['fabric', 'quilt', 'forge', 'neoforge'].includes(expected) && actual === null
