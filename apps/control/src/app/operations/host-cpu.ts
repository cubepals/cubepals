// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The host a boot ran on, kept on the boot's operation as marks where the server's runtime reads
 * it: its CPU (`host_cpu:<model>@<MHz>`) and which host it is (`host:<region>/<name>`). It is read
 * while the server boots, and never fails or holds up a start: a reading that fails, or isn't back
 * in time, leaves the record without one. What is known of each host from every boot's reading is
 * `runtimes/hosts.ts`'s, and what a runtime does about a slow host is its own.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { SECOND_MS } from '@blockly/contracts/durations'
import type { HostCpu, RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'

/** The marks an operation's record keeps of it, beside its steps (`OperationMark`, `runner.ts`). */
export type HostMark = `host_cpu:${string}` | `host:${string}`

const CPU = 'host_cpu:'
const HOST = 'host:'
/** How long a reading may take: far longer than one does, and less than any boot. */
const READ_MS = 15 * SECOND_MS
/** A model's name is a few words; one longer is cut, and still tells kinds of host apart. */
const MODEL_LENGTH = 60

/** A value as a mark holds it: on one line, with no comma, which would split it where marks are listed. */
const plain = (value: string) => value.replace(/[,\s]+/g, ' ').trim()

/**
 * What a reading marks. `host_cpu:AMD EPYC@2850`: the model as the host names it and its clock in
 * whole MHz, `?` for whichever it doesn't say, and no mark where it says neither. And
 * `host:fra/65cd`: the host by its provider's names, where the provider names it.
 */
export function hostMarks(cpu: HostCpu): HostMark[] {
  const marks: HostMark[] = []
  if (cpu.model !== null || cpu.mhz !== null) {
    const model = plain(cpu.model ?? '?').slice(0, MODEL_LENGTH)
    marks.push(`${CPU}${model}@${cpu.mhz === null ? '?' : Math.round(cpu.mhz)}`)
  }
  if (cpu.host !== null) marks.push(`${HOST}${plain(cpu.host.region)}/${plain(cpu.host.id)}`)
  return marks
}

/** Whether a step is one of these marks. */
export const isHostMark = (step: string): boolean => step.startsWith(CPU) || step.startsWith(HOST)

/**
 * The host an operation's steps hold, as its marks say it: its last boot's CPU and host, each
 * empty without its mark.
 */
export function hostOf(steps: readonly string[]): { cpu: string; host: string } {
  const last = (prefix: string) =>
    steps.findLast((step) => step.startsWith(prefix))?.slice(prefix.length) ?? ''
  return { cpu: last(CPU), host: last(HOST) }
}

/** What noting a boot's host reads and writes. */
export interface HostNotes {
  runtime: Pick<Runtimes, 'hostCpu' | 'providerOf'>
  /** Keeps a reading beside every other of its host (`runtimes/hosts.ts`); absent, only the marks keep it. */
  seen?: ((provider: string, cpu: HostCpu) => Promise<void>) | undefined
}

/**
 * Reads the host `handle`'s compute runs on, marks it on the operation and keeps the reading.
 * Never rejects, and settles within `withinMs`: `READ_MS`, unless a test shortens it.
 */
export async function noteHostCpu(
  { runtime, seen }: HostNotes,
  ctx: { mark(mark: HostMark): Promise<void> },
  handle: RuntimeHandle,
  withinMs = READ_MS,
): Promise<void> {
  const waited = new AbortController()
  try {
    const cpu = await Promise.race([
      runtime.hostCpu(handle),
      delay(withinMs, null, { signal: waited.signal }),
    ])
    if (cpu === null) return
    for (const mark of hostMarks(cpu)) await ctx.mark(mark)
    const provider = runtime.providerOf(handle)
    if (provider !== null) await seen?.(provider, cpu)
  } catch {
    // A host that couldn't be read, or kept, says nothing about the start.
  } finally {
    waited.abort()
  }
}
