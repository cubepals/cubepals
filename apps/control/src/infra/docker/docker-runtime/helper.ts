// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs one-shot containers over volumes, as root, each removed when it ends and killed if it runs
 * past its deadline, and asks again after a wait or a log the daemon's answer to never ended. It does not decide what a helper runs or which volumes it sees: the verbs
 * (`docker-runtime.ts`), `archives.ts` and `installs.ts` do.
 */

import type Docker from 'dockerode'
import { ensureImage } from './images.ts'
import { LABEL_DEPLOYMENT } from './labels.ts'

/** The image a helper runs for shell work on a volume: copies, wipes, and keeping an install. */
export const HELPER_IMAGE = 'alpine:3.22'
/** The longest a helper may run before it is killed and its work fails: tar and a large upload. */
const HELPER_DEADLINE_MS = 3 * 60 * 60 * 1000

/**
 * A one-shot container over a server's volumes, as root so the files keep their owners, and
 * removed afterwards. Returns what it printed; anything but exit 0 is an error.
 */
export type RunHelper = (
  image: string,
  command: string[],
  options: { mounts: Docker.MountSettings[]; env?: string[] },
) => Promise<string>

/** The helpers of one deployment on this daemon, labelled as its own. */
export function helperRunner(docker: Docker, deployment: string): RunHelper {
  return async (
    image: string,
    command: string[],
    options: { mounts: Docker.MountSettings[]; env?: string[] },
  ): Promise<string> => {
    await ensureImage(docker, image)
    const container = await docker.createContainer({
      Image: image,
      Cmd: command,
      User: '0',
      Env: options.env ?? [],
      Labels: { [LABEL_DEPLOYMENT]: `${deployment}-helper` },
      HostConfig: { Mounts: options.mounts, ExtraHosts: ['host.docker.internal:host-gateway'] },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await container.start()
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void container.kill().catch(() => undefined)
          reject(
            new Error(
              `A helper container ran past ${Math.round(HELPER_DEADLINE_MS / 60_000)} minutes and was stopped`,
            ),
          )
        }, HELPER_DEADLINE_MS)
      })
      const result = (await Promise.race([
        reasked((abortSignal) => container.wait({ abortSignal })),
        deadline,
      ])) as { StatusCode: number }
      const logs = (await reasked((abortSignal) =>
        container.logs({ stdout: true, stderr: true, abortSignal }),
      )) as Buffer
      if (result.StatusCode !== 0)
        throw new Error(
          `A helper container failed with code ${result.StatusCode}: ${streamOf(logs, 2).trim().slice(0, 300)}`,
        )
      return streamOf(logs, 1)
    } finally {
      clearTimeout(timer)
      await container.remove({ force: true }).catch(() => undefined)
    }
  }
}

/** How long the first ask of a wait or a log has to end before it is asked again. */
const FIRST_ASK_MS = 10_000
/** The longest any one ask is given, however many came before it. */
const LONGEST_ASK_MS = 2 * 60 * 1000

/**
 * A call to the daemon that is asked again when it doesn't end. Bun's node:http client, which
 * dockerode speaks through, now and then takes in the whole of a response the daemon sends after
 * its headers (a wait's exit code, a stopped container's log) and never ends it, so the call would
 * hang for good. Each ask is given twice as long as the one before, up to a ceiling; one that hasn't
 * ended by then is dropped and asked again. Only calls that give the same answer when asked twice
 * belong here: a wait on a helper (an exited container answers at once) and its log.
 */
async function reasked<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let ms = FIRST_ASK_MS; ; ms = Math.min(ms * 2, LONGEST_ASK_MS)) {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const asked = call(abort.signal)
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    })
    try {
      const answer = await Promise.race([asked.then((value) => ({ value })), late])
      if (answer !== null) return answer.value
    } finally {
      clearTimeout(timer)
    }
    // The dropped ask fails once aborted, if it ever settles; nothing waits on it any more.
    asked.catch(() => undefined)
    abort.abort()
  }
}

/**
 * One stream (1 stdout, 2 stderr) of a non-TTY container's log, which is framed: an 8-byte
 * header naming the stream and the length, then the bytes.
 */
function streamOf(framed: Buffer, stream: 1 | 2): string {
  let out = ''
  for (let at = 0; at + 8 <= framed.length; ) {
    const length = framed.readUInt32BE(at + 4)
    if (framed[at] === stream) out += framed.subarray(at + 8, at + 8 + length).toString('utf8')
    at += 8 + length
  }
  return out
}
