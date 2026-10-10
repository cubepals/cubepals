// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shell scripts helper machines run, and what they print read back: an archive of a volume
 * sent in one PUT or left for parts, the parts sent, and a volume filled from an archive. Pure:
 * running a script on a machine, and the result line it leaves, is `helper-machine.ts`.
 */

import type { PartsUpload, PutPart, UploadTarget } from '../../../app/ports/runtime.ts'
import { job } from './helper-machine.ts'

/**
 * Parts one job sends: each part's presigned link is in the job's script, and a few of them fill
 * what Fly's exec takes. A larger archive is sent by several jobs, one after another.
 */
export const PARTS_PER_JOB = 8

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const headerArgs = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([name, value]) => `-H ${quote(`${name}: ${value}`)}`)
    .join(' ')

/**
 * Archives the volume beside itself and measures it. One PUT carries it: uploaded to the
 * presigned URL (`put <sha> <size>`). Larger: left on the volume for `partsJob` (`parts <sha>
 * <size>`).
 */
export function exportJob(target: UploadTarget, maxPutBytes: number): string {
  return job(
    [
      '  cd /data &&',
      '  rm -f .blockly-export.tgz &&',
      '  tar -czf .blockly-export.tgz --exclude=./.blockly-export.tgz . &&',
      "  sha=$(sha256sum .blockly-export.tgz | cut -d' ' -f1) &&",
      '  size=$(stat -c %s .blockly-export.tgz) &&',
      `  if [ "$size" -gt ${maxPutBytes} ]; then echo "parts $sha $size"; else`,
      `  curl -fsS -X PUT --upload-file .blockly-export.tgz ${headerArgs(target.headers)} ${quote(target.url)} > /dev/null &&`,
      '  echo "put $sha $size"; fi',
    ].join('\n'),
  )
}

/** The parts an archive of `sizeBytes` fills, numbered from 1, `most` to a batch. */
export function partBatches(parts: PartsUpload, sizeBytes: number, most: number): number[][] {
  const count = Math.max(1, Math.ceil(sizeBytes / parts.partSize))
  if (count > parts.urls.length)
    throw new Error(`${sizeBytes} bytes need ${count} parts; the store gave ${parts.urls.length}`)
  const batches: number[][] = []
  for (let first = 1; first <= count; first += most)
    batches.push(Array.from({ length: Math.min(most, count - first + 1) }, (_, index) => first + index))
  return batches
}

/**
 * Sends parts of the archive `exportJob` left, each streamed from it by dd with its length
 * declared (S3 takes no chunked upload, so curl's is switched off), each tried three times.
 * Prints `n=etag` for each.
 */
export function partsJob(parts: PartsUpload, sizeBytes: number, numbers: readonly number[]): string {
  const mib = parts.partSize / 1024 / 1024
  if (!Number.isInteger(mib)) throw new Error(`A part of ${parts.partSize} bytes isn't a whole number of MiB`)
  const calls = numbers.map((number) => {
    const length = Math.min(parts.partSize, sizeBytes - (number - 1) * parts.partSize)
    return `  put_part ${number} ${(number - 1) * mib} ${length} ${quote(parts.urls[number - 1] ?? '')} &&`
  })
  return job(
    [
      '  cd /data &&',
      '  put_part() {',
      '    tries=0',
      '    while :; do',
      `      tag=$(dd if=.blockly-export.tgz bs=1048576 skip="$2" count=${mib} 2>/dev/null | curl -fsS -o /dev/null -D - -X PUT -T - -H "Content-Length: $3" -H "Transfer-Encoding:" ${headerArgs(parts.headers)} "$4" | tr -d '\\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p')`,
      '      [ -n "$tag" ] && break',
      '      tries=$((tries + 1)); [ "$tries" -lt 3 ] || return 1',
      '      sleep 2',
      '    done',
      '    printf "%s=%s " "$1" "$tag"',
      '  } &&',
      ...calls,
      '  echo',
    ].join('\n'),
  )
}

/** What `partsJob` printed: `1="etag" 2="etag" …`. */
export function partsPut(line: string): PutPart[] {
  return line
    .trim()
    .split(/\s+/)
    .filter((pair) => pair.includes('='))
    .map((pair) => ({
      number: Number(pair.slice(0, pair.indexOf('='))),
      etag: pair.slice(pair.indexOf('=') + 1),
    }))
}

/** Fills an empty volume from an archive; extracting as root keeps the archive's owners. */
export function restoreJob(url: string): string {
  return job(`  curl -fsSL ${quote(url)} | tar -xzf - -C /data && echo restored`)
}
