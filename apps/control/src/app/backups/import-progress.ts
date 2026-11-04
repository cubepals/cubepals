// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measured world-import stages and byte counts, persisted at a bounded rate for polling and
 * diagnosis. A display aid only: a write the database refuses is logged and skipped, so it never
 * fails or undoes the import it measures.
 */
import type { WorldImportProgress } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { inFull } from '../errors.ts'
import type { TarballEntry } from '../ports/formats.ts'

const REPORT_EVERY_MS = 2 * SECOND_MS

export class ImportProgress {
  #state: WorldImportProgress | null = null
  #reportedAt = 0
  readonly #db: Db
  readonly #importId: string

  constructor(db: Db, importId: string) {
    this.#db = db
    this.#importId = importId
  }

  async step(step: WorldImportProgress['step'], totalBytes: number | null = null): Promise<void> {
    const at = new Date().toISOString()
    this.#state = {
      step,
      startedAt: this.#state?.startedAt ?? at,
      updatedAt: at,
      bytes: 0,
      totalBytes,
      steps: [...(this.#state?.steps ?? []), { step, at }],
    }
    await this.#write()
  }

  async bytes(bytes: number): Promise<void> {
    if (this.#state === null) return
    this.#state.bytes = bytes
    if (Date.now() - this.#reportedAt < REPORT_EVERY_MS && bytes !== this.#state.totalBytes) return
    await this.#write()
  }

  /** Count source bytes consumed, so compression never invents a denominator for the output size. */
  async *entries(entries: AsyncIterable<TarballEntry>): AsyncIterable<TarballEntry> {
    let bytes = 0
    for await (const entry of entries) {
      const body = entry.data
      if (body instanceof Uint8Array) {
        bytes += body.byteLength
        await this.bytes(bytes)
        yield entry
      } else {
        yield {
          ...entry,
          data: body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform: async (chunk, controller) => {
                bytes += chunk.byteLength
                await this.bytes(bytes)
                controller.enqueue(chunk)
              },
            }),
          ),
        }
      }
    }
  }

  async #write(): Promise<void> {
    if (this.#state === null) return
    this.#reportedAt = Date.now()
    this.#state.updatedAt = new Date(this.#reportedAt).toISOString()
    await this.#db
      .update(schema.worldImports)
      .set({ progress: { ...this.#state } })
      .where(and(eq(schema.worldImports.id, this.#importId), eq(schema.worldImports.status, 'reading')))
      .catch((error: unknown) =>
        console.warn(`world-import ${this.#importId}: progress not written: ${inFull(error)}`),
      )
  }
}
