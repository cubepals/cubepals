// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moves a volume's files to and from the archive store as a tar.gz, from helper containers that
 * reach the store the way a game runtime does: up in one PUT or in parts, down from a link. It
 * never makes or removes a volume: which snapshot goes, the scratch volume it is packed in, and
 * where a restore unpacks are the verbs' (`docker-runtime.ts`).
 */

import type Docker from 'dockerode'
import type { ArchiveTarget, DownloadTarget, PartsUpload, PutPart } from '../../../app/ports/runtime.ts'
import type { RunHelper } from './helper.ts'

/** Archives go out and come back over HTTP: the helper needs curl, and this image is pinned in compose too. */
const ARCHIVER_IMAGE = 'curlimages/curl:8.22.0'
/**
 * How the helper talks to the store: a connection that won't open, or a transfer slower than
 * 1 KB/s for a minute, fails and is retried; refusals (403, 404) are not retried. A transfer
 * is never cut off for merely being long: worlds can be large.
 */
const CURL =
  'curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-delay 2'
const headerArgs = (headers: Record<string, string>) =>
  Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`])

/**
 * A tar.gz of `from`'s files, packed into the `scratch` volume and put where `target` says: in one
 * PUT, or, when larger than one carries, by a second helper in parts, aborted if they fail.
 */
export async function exportArchive(
  helper: RunHelper,
  from: string,
  scratch: string,
  target: ArchiveTarget,
): Promise<{ sizeBytes: number; sha256: string }> {
  const out = { Type: 'volume' as const, Source: scratch, Target: '/out' }
  const output = await helper(
    ARCHIVER_IMAGE,
    [
      'sh',
      '-c',
      `tar -czf /out/world.tar.gz -C /from . && sha256sum /out/world.tar.gz && stat -c %s /out/world.tar.gz && if [ "$(stat -c %s /out/world.tar.gz)" -gt "$MOST" ]; then echo parts; else ${CURL} -o /dev/null -X PUT -T /out/world.tar.gz "$@" "$TARGET" && echo put; fi`,
      'export',
      ...headerArgs(target.put.headers),
    ],
    {
      mounts: [{ Type: 'volume', Source: from, Target: '/from', ReadOnly: true }, out],
      env: [`TARGET=${target.put.url}`, `MOST=${target.maxPutBytes}`],
    },
  )
  const [hashLine = '', sizeLine = '', how = ''] = output.trim().split('\n')
  const sha256 = hashLine.split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new Error(`The archive's hash didn't come back: ${output.slice(0, 200)}`)
  const sizeBytes = Number.parseInt(sizeLine, 10)
  if (how.trim() === 'parts') {
    const parts = await target.inParts(sizeBytes)
    try {
      await parts.complete(await sendParts(helper, out, parts, sizeBytes))
    } catch (error) {
      await parts.abort().catch(() => undefined)
      throw error
    }
  }
  return { sha256, sizeBytes }
}

/**
 * The archive at `download` unpacked into `volume`, in place of what it held. The helper fetches
 * the archive the way a game runtime would reach the store, and checks it is a whole tarball before
 * the volume is emptied: a bad download leaves the world alone.
 */
export async function unpackArchive(
  helper: RunHelper,
  volume: string,
  download: DownloadTarget,
): Promise<void> {
  await helper(
    ARCHIVER_IMAGE,
    [
      'sh',
      '-c',
      `${CURL} -o /tmp/world.tar.gz "$SOURCE" && tar -tzf /tmp/world.tar.gz > /dev/null && find /to -mindepth 1 -delete && tar -xzf /tmp/world.tar.gz -C /to`,
    ],
    {
      mounts: [{ Type: 'volume', Source: volume, Target: '/to' }],
      env: [`SOURCE=${download.url}`],
    },
  )
}

/**
 * The archive in `/out/world.tar.gz` sent in parts, each streamed from it by dd with its length
 * declared (S3 takes no chunked upload, so curl's is switched off), each tried three times.
 */
async function sendParts(
  helper: RunHelper,
  out: Docker.MountSettings,
  parts: PartsUpload,
  sizeBytes: number,
): Promise<PutPart[]> {
  const count = Math.max(1, Math.ceil(sizeBytes / parts.partSize))
  if (count > parts.urls.length)
    throw new Error(`${sizeBytes} bytes need ${count} parts; the store gave ${parts.urls.length}`)
  const output = await helper(
    ARCHIVER_IMAGE,
    [
      'sh',
      '-c',
      [
        'i=1',
        'while [ "$i" -le "$PARTS" ]; do',
        '  eval "url=\\$PART_$i"',
        '  len=$(( SIZE - (i - 1) * MIB * 1048576 )); [ "$len" -gt $(( MIB * 1048576 )) ] && len=$(( MIB * 1048576 ))',
        '  tries=0',
        '  while :; do',
        '    tag=$(dd if=/out/world.tar.gz bs=1048576 skip=$(( (i - 1) * MIB )) count="$MIB" 2>/dev/null | curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o /dev/null -D - -X PUT -T - -H "Content-Length: $len" -H "Transfer-Encoding:" "$@" "$url" | tr -d \'\\r\' | sed -n \'s/^[Ee][Tt][Aa][Gg]: *//p\')',
        '    [ -n "$tag" ] && break',
        '    tries=$((tries + 1)); [ "$tries" -lt 3 ] || exit 1',
        '    sleep 2',
        '  done',
        '  echo "$i=$tag"',
        '  i=$((i + 1))',
        'done',
      ].join('\n'),
      'parts',
      ...headerArgs(parts.headers),
    ],
    {
      mounts: [{ ...out, ReadOnly: true }],
      env: [
        `SIZE=${sizeBytes}`,
        `MIB=${parts.partSize / 1024 / 1024}`,
        `PARTS=${count}`,
        ...parts.urls.slice(0, count).map((url, index) => `PART_${index + 1}=${url}`),
      ],
    },
  )
  const put = output
    .trim()
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => ({
      number: Number(line.slice(0, line.indexOf('='))),
      etag: line.slice(line.indexOf('=') + 1),
    }))
  if (put.length !== count)
    throw new Error(`${count} parts were to go; ${put.length} went: ${output.slice(0, 200)}`)
  return put
}
