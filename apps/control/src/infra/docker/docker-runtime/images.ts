// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pulls an image the daemon doesn't have, and gives up on a pull that stalls. A pull whose progress
 * goes quiet is dropped and asked again (`../reasked.ts`): the daemon may have sent its last line
 * and the answer never ended, and pulling again only finds the image or carries on. It does not
 * decide which image a server or a helper runs: the verbs (`docker-runtime.ts`) and `helper.ts` do.
 */

import type Docker from 'dockerode'
import { reasked } from '../reasked.ts'

/** A pull that takes longer than this has stalled; the Minecraft image is the largest pulled. */
const PULL_DEADLINE_MS = 20 * 60 * 1000

export async function ensureImage(docker: Docker, image: string): Promise<void> {
  // A registry that stops sending would otherwise hold the operation forever.
  const pulling = new AbortController()
  const timer = setTimeout(
    () => pulling.abort(new Error(`Pulling ${image} took longer than ${PULL_DEADLINE_MS / 60_000} minutes`)),
    PULL_DEADLINE_MS,
  )
  try {
    await reasked(async ({ signal, alive }) => {
      const found = await docker
        .getImage(image)
        .inspect()
        .catch(() => null)
      if (found) return
      const stream = await docker.pull(image, { abortSignal: signal })
      await new Promise<void>((resolve, reject) =>
        docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()), alive),
      )
    }, pulling.signal)
  } finally {
    clearTimeout(timer)
  }
}
