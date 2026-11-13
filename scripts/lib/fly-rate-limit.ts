// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * flyctl, run again when Fly's API turns a request away for its rate limit: one request a second
 * per action per machine, in bursts of up to three, and five a second for reading a machine
 * (docs.fly.io/machines/api/working-with-machines-api). A script that changes a machine and then
 * starts it, as `staging.ts start` does with the control plane's, can meet it. Each of the scripts'
 * wrappers of flyctl (`staging.ts`, `staging-database.ts`, `control-wake.ts`, `fly-async.ts`) runs
 * it through here and keeps its own way of saying what failed.
 *
 * A read is also run again when Fly's API drops the connection before it answers
 * (`FLY_STREAM_DROPPED`): a list that failed changed nothing, so asking again is safe. A command
 * that changes something is not, since the change may have gone through before the drop.
 *
 * Not for any other failure: flyctl's answer comes back at once, as it did.
 */

import { SECOND_MS } from '@blockly/contracts/durations'

/**
 * What flyctl prints when Fly's API refuses a request for its rate limit, as in "resource_exhausted:
 * rate limit exceeded (Request ID: …)". Fly's documentation gives the limits but not the answer.
 */
export const FLY_RATE_LIMITED = /rate limit exceeded/i

/**
 * What flyctl prints when Fly's API resets the connection in the middle of an answer, as in
 * `stream error: stream ID 1; INTERNAL_ERROR; received from peer`, which a nightly's `fly ips list`
 * was given once. The words are Go's HTTP/2 client's, for a stream its peer reset.
 */
export const FLY_STREAM_DROPPED = /stream error: stream ID \d+; INTERNAL_ERROR/

/** Whether `args` only read: a list (`ips list`, `machines list`) or a status. */
const reads = (args: readonly string[]): boolean => args[1] === 'list' || args[0] === 'status'

/** How long to wait before each new try. The limits are per second, so a few seconds clear them. */
export const RATE_LIMIT_WAITS_MS = [1, 2, 4, 8].map((n) => n * SECOND_MS)

/** What one run of flyctl gave back. */
export interface FlyRun {
  exitCode: number
  stdout: string
  stderr: string
}

/** Whether `run` of `args` is worth another try: turned away for the rate limit, or a read whose answer was dropped. */
function again(args: readonly string[], run: FlyRun): boolean {
  if (run.exitCode === 0) return false
  const said = `${run.stdout}\n${run.stderr}`
  return FLY_RATE_LIMITED.test(said) || (reads(args) && FLY_STREAM_DROPPED.test(said))
}

/** Runs `fly` with `args`, holding the script until it answers; tried again after each rate limit or dropped read. */
export function flySync(args: string[], input?: string, wait: (ms: number) => void = Bun.sleepSync): FlyRun {
  for (const delay of [...RATE_LIMIT_WAITS_MS, null]) {
    const result = Bun.spawnSync(['fly', ...args], {
      stdin: input === undefined ? 'ignore' : Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
      // The environment as it is now, PATH included, which a script may have added to.
      env: process.env,
    })
    const run = {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
    if (!again(args, run) || delay === null) return run
    wait(delay)
  }
  throw new Error('unreachable: the last try returns')
}

/** Runs `fly` with `args` while the script goes on; tried again after each rate limit or dropped read. */
export async function flyAsync(
  args: string[],
  wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<FlyRun> {
  for (const delay of [...RATE_LIMIT_WAITS_MS, null]) {
    const child = Bun.spawn(['fly', ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const run = { exitCode, stdout, stderr }
    if (!again(args, run) || delay === null) return run
    await wait(delay)
  }
  throw new Error('unreachable: the last try returns')
}
