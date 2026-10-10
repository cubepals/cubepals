// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs one program on this computer and collects what it printed. It does not decide what the
 * program sees as its storage: `exec` in `fake-runtime.ts` rewrites the mount path first.
 */

import { spawn } from 'node:child_process'
import type { ExecResult } from '../../../app/ports/runtime.ts'

/**
 * The program's exit and output; killed after `timeoutMs`. A failing exit rejects, with what it
 * printed to stderr, unless `tolerateFailure` asks for it as a result.
 */
export function run(
  program: string,
  args: readonly string[],
  timeoutMs = 60_000,
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
