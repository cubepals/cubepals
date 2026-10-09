/**
 * Pulls an image the daemon doesn't have, and gives up on a pull that stalls. It does not decide
 * which image a server or a helper runs: the verbs (`docker-runtime.ts`) and `helper.ts` do.
 */

import type Docker from 'dockerode'

/** A pull that takes longer than this has stalled; the Minecraft image is the largest pulled. */
const PULL_DEADLINE_MS = 20 * 60 * 1000

export async function ensureImage(docker: Docker, image: string): Promise<void> {
  const found = await docker
    .getImage(image)
    .inspect()
    .catch(() => null)
  if (found) return
  const stream = await docker.pull(image)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // A registry that stops sending would otherwise hold the operation forever.
    await Promise.race([
      new Promise<void>((resolve, reject) =>
        docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ;(stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
          reject(new Error(`Pulling ${image} took longer than ${PULL_DEADLINE_MS / 60_000} minutes`))
        }, PULL_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
