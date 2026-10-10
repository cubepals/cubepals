// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moves a storage directory to and from an archive store as a gzipped tar: up in one PUT or in
 * parts, as the Fly and Docker exports do, and down from a link. It never sees a server or a
 * handle; which snapshot goes, whether an export may run now, and where a restore unpacks are the
 * runtime's (`fake-runtime.ts`).
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArchiveTarget, PutPart } from '../../../app/ports/runtime.ts'
import { run } from './command.ts'

/**
 * `dir` packed under a scratch directory in `scratchRoot` and uploaded with its length: in one
 * PUT, or in parts when it is larger than one PUT carries, the store's limit or the fake's own
 * (`ownMaxPutBytes`, asked once the archive is packed). A failed upload in parts is aborted; the
 * scratch goes either way.
 */
export async function exportArchive(
  dir: string,
  scratchRoot: string,
  target: ArchiveTarget,
  ownMaxPutBytes: () => number | null,
): Promise<{ sizeBytes: number; sha256: string }> {
  const scratch = await mkdtemp(join(scratchRoot, 'export-'))
  try {
    const file = join(scratch, 'world.tar.gz')
    await run('tar', ['-czf', file, '-C', dir, '.'])
    const bytes = await readFile(file)
    const sent = { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    if (bytes.length <= Math.min(target.maxPutBytes, ownMaxPutBytes() ?? Number.POSITIVE_INFINITY)) {
      await put(target.put.url, target.put.headers, bytes)
      return sent
    }
    const parts = await target.inParts(bytes.length)
    try {
      const done: PutPart[] = []
      for (let start = 0, number = 1; start < bytes.length; start += parts.partSize, number++) {
        const url = parts.urls[number - 1]
        if (url === undefined)
          throw new Error(`${bytes.length} bytes need more parts than ${parts.urls.length}`)
        const etag = await put(url, parts.headers, bytes.subarray(start, start + parts.partSize))
        done.push({ number, etag })
      }
      await parts.complete(done)
    } catch (error) {
      await parts.abort()
      throw error
    }
    return sent
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** The archive at `url`, downloaded beside `dir` and unpacked into it. */
export async function unpackArchive(url: string, dir: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading the archive answered ${response.status}`)
  const file = `${dir}.download.tar.gz`
  await writeFile(file, Buffer.from(await response.arrayBuffer()))
  try {
    await run('tar', ['-xzf', file, '-C', dir])
  } finally {
    await rm(file, { force: true })
  }
}

/** One PUT of `bytes`, as a runtime sends an archive or a part of one; the ETag it was answered with. */
async function put(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-length': String(bytes.length) },
    body: bytes,
  })
  if (!response.ok) throw new Error(`The upload was refused with ${response.status}`)
  return response.headers.get('etag') ?? ''
}
