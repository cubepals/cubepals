/**
 * A snapshot's archive, uploaded to the archive store from inside its sandbox: in one PUT or, larger
 * than one carries, in parts. It neither finds nor wakes the sandbox, which `boat-runtime.ts` does
 * before handing it over, and runs the sandbox's program only through `commands.ts`.
 */

import type { ArchiveTarget } from '../../../app/ports/runtime.ts'
import { JOB_SECONDS, type SandboxCommands } from './commands.ts'

/** An archive's parts each have a link on the command line Boat runs: few, then, and larger. */
const PARTS_ON_A_LINE = 16

const headerArgs = (headers: Record<string, string>) =>
  Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`])

/**
 * The upload in parts has their links on the command line, so fewer and larger; an upload in parts
 * that fails for any reason is aborted before the failure goes on.
 */
export async function exportArchive(
  commands: Pick<SandboxCommands, 'run'>,
  sandboxId: string,
  file: string,
  target: ArchiveTarget,
): Promise<{ sizeBytes: number; sha256: string }> {
  const said = (
    await commands.run(
      sandboxId,
      'export',
      [file, target.put.url, String(target.maxPutBytes), ...headerArgs(target.put.headers)],
      JOB_SECONDS,
    )
  ).split(' ')
  const inParts = said[0] === 'parts'
  const [sha256 = '', size = '0'] = inParts ? said.slice(1) : said
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`The archive's hash didn't come back: ${sha256}`)
  const sizeBytes = Number(size)
  if (inParts) {
    const parts = await target.inParts(sizeBytes, PARTS_ON_A_LINE)
    try {
      const count = Math.max(1, Math.ceil(sizeBytes / parts.partSize))
      if (count > parts.urls.length)
        throw new Error(`${sizeBytes} bytes need ${count} parts; the store gave ${parts.urls.length}`)
      const line = await commands.run(
        sandboxId,
        'export-parts',
        [
          file,
          String(parts.partSize / 1024 / 1024),
          size,
          parts.urls.slice(0, count).join('\n'),
          ...headerArgs(parts.headers),
        ],
        JOB_SECONDS,
      )
      const put = line
        .split(/\s+/)
        .filter((pair) => pair.includes('='))
        .map((pair) => ({
          number: Number(pair.slice(0, pair.indexOf('='))),
          etag: pair.slice(pair.indexOf('=') + 1),
        }))
      if (put.length !== count) throw new Error(`${count} parts were to go; ${put.length} went`)
      await parts.complete(put)
    } catch (error) {
      await parts.abort().catch(() => undefined)
      throw error
    }
  }
  return { sha256, sizeBytes }
}
