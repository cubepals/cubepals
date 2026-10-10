// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs one shell job on a throwaway Fly machine mounted on a volume, and reads back the one line
 * it leaves; the machine goes whether the job succeeds or not. What the jobs do is
 * `helper-jobs.ts`; making and deleting the volume is the verb that asks for the job.
 */

import type { FlyClient } from '../client.ts'
import { META } from '../machine-config.ts'
import { destroyMachine, exec, waitFor } from './machines.ts'
import { idOf, launched } from './responses.ts'

/** sh, tar, gzip, sha256sum, stat and curl: enough to archive a volume or fill one. */
const HELPER_IMAGE = 'curlimages/curl:8.22.0'
/** Well under what Fly's exec takes as one argument; the jobs Blockly runs are a few hundred bytes. */
const HELPER_SCRIPT_BYTES = 16_384
/** A helper copies and packs files for a while and plays no game: the smallest shared machine. */
const HELPER_GUEST = { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 }

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
 * job takes. Returns what followed "ok".
 */
export async function helperJob(
  fly: FlyClient,
  deployment: string,
  app: string,
  region: string,
  volumeId: string,
  script: string,
): Promise<string> {
  const helper = launched(
    await fly.POST('/v1/apps/{app_name}/machines', {
      params: { path: { app_name: app } },
      body: {
        name: `helper-${Date.now().toString(36)}`,
        region,
        config: {
          image: HELPER_IMAGE,
          init: { exec: ['/bin/sleep', '86400'] },
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
    await waitFor(fly, app, helperId, 'started', 300)
    // Fly's exec passes no stdin (a script sent that way arrived empty on staging, 2026-09-26), so
    // the script travels as an argument, which Fly caps somewhere below 60 kB.
    if (Buffer.byteLength(script) > HELPER_SCRIPT_BYTES)
      throw new Error('The helper job is too long to hand to Fly')
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
    const deadline = Date.now() + 6 * 3600_000
    while (Date.now() < deadline) {
      // Its result; else whether it still runs; else, read once more, since it may have just
      // finished. A job that ended without a result fails now, not at the deadline.
      const line = (
        await exec(
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
      ).stdout.trim()
      if (line.startsWith('ok')) return line.slice(2).trim()
      if (line.startsWith('failed') || line === 'gone') {
        const log = await exec(fly, app, helperId, ['sh', '-c', 'tail -c 800 /tmp/job.log'], 30)
        throw new Error(
          line === 'gone'
            ? `The helper job stopped without a result: ${log.stdout}`
            : `The helper job failed (${line}): ${log.stdout}`,
        )
      }
      await sleep(5000)
    }
    throw new Error('The helper job did not finish in six hours')
  } finally {
    await destroyMachine(fly, app, helperId)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
