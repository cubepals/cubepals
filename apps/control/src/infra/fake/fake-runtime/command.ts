// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs one program on this computer and collects what it printed, or prints for `du` and `df` what
 * a test says a server's disk holds. It does not decide what the program sees as its storage:
 * `exec` in `fake-runtime.ts` rewrites the mount path first.
 */

import { spawn } from 'node:child_process'
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { ExecResult, RuntimeSpec } from '../../../app/ports/runtime.ts'

/**
 * The program's exit and output; killed after `timeoutMs`. A failing exit rejects, with what it
 * printed to stderr, unless `tolerateFailure` asks for it as a result.
 */
export function run(
  program: string,
  args: readonly string[],
  timeoutMs = MINUTE_MS,
  options: { tolerateFailure?: boolean } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const result = { exitCode: code ?? 137, stdout, stderr }
      if (code !== 0 && !options.tolerateFailure)
        reject(new Error(`${program} exited with ${code}: ${stderr.trim()}`))
      else resolve(result)
    })
  })
}

/**
 * What `du -sk` and `df -Pk` print where a test said the storage holds `usedKb` (`reportDiskUsage`):
 * the disk is the size its spec asked for, and what isn't used is free. Null for any other program,
 * or where the test said nothing, so the real one runs.
 */
export function reportedDisk(
  program: string,
  usedKb: number | undefined,
  storage: Pick<RuntimeSpec['storage'], 'mountPath' | 'sizeGb'>,
): ExecResult | null {
  if (usedKb === undefined) return null
  if (program === 'du') return { exitCode: 0, stdout: `${usedKb}\t${storage.mountPath}\n`, stderr: '' }
  if (program !== 'df') return null
  const sizeKb = storage.sizeGb * 2 ** 20
  const free = Math.max(0, sizeKb - usedKb)
  const line = `fake ${sizeKb} ${usedKb} ${free} ${Math.ceil((usedKb / sizeKb) * 100)}% ${storage.mountPath}`
  return {
    exitCode: 0,
    stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\n${line}\n`,
    stderr: '',
  }
}
