import type { ArchiveTarget, PutPart } from '../app/ports/runtime.ts'
import { MAX_PUT_BYTES, partPlan } from '../infra/s3/parts.ts'

/** What a test's archive target was asked: the uploads in parts begun, and how each ended. */
export interface TargetLog {
  asked: Array<{ sizeBytes: number; most: number | undefined }>
  completed: PutPart[][]
  aborted: number
}

/**
 * An archive target that stores nothing, for a runtime test that only reads what the runtime
 * asked of it: one PUT link, and links for parts planned as the S3 store plans them (or of
 * `partSize`, when a test wants many), each upload in parts ending in `log`.
 */
export function recordingTarget(
  options: { url?: string; maxPutBytes?: number; partSize?: number } = {},
): ArchiveTarget & { log: TargetLog } {
  const url = options.url ?? 'https://bucket.example/world.tgz?sig=1'
  const log: TargetLog = { asked: [], completed: [], aborted: 0 }
  return {
    log,
    put: { url, headers: {} },
    maxPutBytes: options.maxPutBytes ?? MAX_PUT_BYTES,
    inParts: async (sizeBytes, most) => {
      log.asked.push({ sizeBytes, most })
      const planned = partPlan(sizeBytes, most)
      const partSize = options.partSize ?? planned.partSize
      const count = options.partSize === undefined ? planned.count : Math.ceil(sizeBytes / partSize)
      return {
        partSize,
        urls: Array.from({ length: count }, (_, index) => `${url}&part=${index + 1}`),
        headers: {},
        complete: async (parts) => {
          log.completed.push([...parts])
        },
        abort: async () => {
          log.aborted++
        },
      }
    },
  }
}
