// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs one shell job on a throwaway Fly machine mounted on a volume, and reads back the one line
 * it leaves; the machine goes whether the job succeeds or not. A read that fails is read again,
 * and the job given up only once reads have failed for a while. What the jobs do is
 * `helper-jobs.ts`; making and deleting the volume is the verb that asks for the job.
 */

import { HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { FlyClient } from '../client.ts'
import { META } from '../machine-config.ts'
import { destroyMachine, exec, waitFor } from './machines.ts'
import { idOf, launched } from './responses.ts'

/** sh, tar, gzip, sha256sum, stat and curl: enough to archive a volume or fill one. */
const HELPER_IMAGE = 'curlimages/curl:8.22.0'
/** Well under what Fly's exec takes as one argument; the jobs Blockly runs are a few hundred bytes. */
const HELPER_SCRIPT_BYTES = 16_384
/**
 * A helper packs or unpacks a world, which is one core's work for as long as it lasts, and a
 * shared CPU is held to a fraction of a core once its burst is spent: packing 3 GB took 938 s on
 * one and 196 s on this, on the same volume. A full core with the least memory it comes with.
 */
const HELPER_GUEST = { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 }

/** How long a job's result is read every `quickMs`, before every `slowMs`. */
const QUICK_READS_MS = 20_000
/**
 * How a job's result is read. A small world's copy is done in seconds, while a server waits on it
 * to wake: it is read every `quickMs` at first. A long job is read every `slowMs`, since every
 * read is a call to Fly. `failingMs` is how long reads may fail, one after another, before the
 * helper counts as lost (`jobReader`): a minute, far longer than a refusal that passes takes, and
 * little to add to a job whose helper is gone. Tests shorten them.
 */
interface JobReads {
  quickMs: number
  slowMs: number
  failingMs: number
}
export const JOB_READS: JobReads = { quickMs: SECOND_MS, slowMs: 5 * SECOND_MS, failingMs: MINUTE_MS }
/** How long a helper may take to start, and then its job to run. */
const HELPER_START_SECONDS = 300
const JOB_DEADLINE_MS = 6 * HOUR_MS
/**
 * The longest a helper lives: it sleeps no longer, and then Fly destroys it (`auto_destroy`). One
 * older is left from work that stopped without destroying it, and is the sweep's to clear.
 */
export const HELPER_LIFETIME_MS = HELPER_START_SECONDS * 1000 + JOB_DEADLINE_MS

/** A background job that leaves "ok <output>" or "failed <status>" in /tmp/job.result. */
export function job(body: string): string {
  return [
    'set -u',
    'set -o pipefail',
    'run() {',
    body,
    '}',
    'if out=$(run); then echo "ok $out" > /tmp/job.result; else echo "failed $?" > /tmp/job.result; fi',
    '',
  ].join('\n')
}

/**
 * A one-shot helper machine on `volumeId` at /data runs `script` in the background, and is
 * polled for the one line it leaves in /tmp/job.result. Exec calls stay short however long the
 * job takes, and one that fails to read the job is asked again (`jobReader`). Returns what
 * followed "ok".
 */
export async function helperJob(
  fly: FlyClient,
  deployment: string,
  app: string,
  region: string,
  volumeId: string,
  script: string,
  /** Aborted, the job is given up between reads and its machine destroyed, as on any failure. */
  signal?: AbortSignal,
  reads: JobReads = JOB_READS,
): Promise<string> {
  signal?.throwIfAborted()
  const helper = launched(
    await fly.POST('/v1/apps/{app_name}/machines', {
      params: { path: { app_name: app } },
      body: {
        name: `helper-${Date.now().toString(36)}`,
        region,
        config: {
          image: HELPER_IMAGE,
          init: { exec: ['/bin/sleep', String(HELPER_LIFETIME_MS / 1000)] },
          guest: HELPER_GUEST,
          mounts: [{ volume: volumeId, path: '/data' }],
          restart: { policy: 'no' },
          auto_destroy: true,
          metadata: { [META.deployment]: deployment, [META.role]: 'helper' },
        },
      },
    }),
    'creating a helper machine',
  )
  const helperId = idOf(helper, 'a helper machine')
  try {
    await waitFor(fly, app, helperId, 'started', HELPER_START_SECONDS)
    // Fly's exec passes no stdin (a script sent that way arrived empty on staging, 2026-09-26), so
    // the script travels as an argument, which Fly caps somewhere below 60 kB.
    if (Buffer.byteLength(script) > HELPER_SCRIPT_BYTES)
      throw new Error('The helper job is too long to hand to Fly')
    // Asked once: after a start that failed, nothing says whether the job runs.
    await exec(
      fly,
      app,
      helperId,
      [
        'sh',
        '-c',
        'printf "%s" "$0" > /tmp/job.sh && { nohup sh /tmp/job.sh > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid; }',
        script,
      ],
      30,
    )
    const began = Date.now()
    const deadline = began + JOB_DEADLINE_MS
    const read = jobReader(fly, app, helperId, reads.failingMs, signal)
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      // A job that ended without a result fails now, not at the deadline.
      const line = await read()
      if (line.startsWith('ok')) return line.slice(2).trim()
      if (line.startsWith('failed') || line === 'gone') {
        const log = await exec(fly, app, helperId, ['sh', '-c', 'tail -c 800 /tmp/job.log'], 30)
        throw new Error(
          line === 'gone'
            ? `The helper job stopped without a result: ${log.stdout}`
            : `The helper job failed (${line}): ${log.stdout}`,
        )
      }
      await sleep(Date.now() - began < QUICK_READS_MS ? reads.quickMs : reads.slowMs)
    }
    throw new Error('The helper job did not finish in six hours')
  } finally {
    await destroyMachine(fly, app, helperId)
  }
}

/**
 * Reads of what a job has left, one at each call: its result line, `running` while it runs, or
 * `gone` once it ended without one. A read is a call to Fly, and one that fails says nothing of
 * the job, which runs on in the machine: Fly refused one, 412, its exec finding "No child
 * process", while the job it asked after went on packing. So a failed read counts as `running`
 * and is said to the log, and the next read decides. Only once reads have failed, one after
 * another, for `failingMs` is the helper taken as lost, and the last read's error thrown. Aborted
 * meanwhile, `signal`'s reason is thrown, never a read's error.
 */
function jobReader(
  fly: FlyClient,
  app: string,
  helperId: string,
  failingMs: number,
  signal?: AbortSignal,
): () => Promise<string> {
  let failingSince: number | null = null
  return async () => {
    try {
      // Its result; else whether it still runs; else, read once more, since it may have just
      // finished.
      const read = await exec(
        fly,
        app,
        helperId,
        [
          'sh',
          '-c',
          'cat /tmp/job.result 2>/dev/null || { kill -0 "$(cat /tmp/job.pid)" 2>/dev/null && echo running; } || cat /tmp/job.result 2>/dev/null || echo gone',
        ],
        30,
      )
      failingSince = null
      return read.stdout.trim()
    } catch (error) {
      signal?.throwIfAborted()
      failingSince ??= Date.now()
      if (Date.now() - failingSince >= failingMs) throw error
      // The read's command is the same for every job, so what Fly says of it holds no script.
      const said = error instanceof Error ? error.message : String(error)
      console.warn(`fly: ${app} couldn't read helper ${helperId}'s job (${said}); reading it again`)
      return 'running'
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
