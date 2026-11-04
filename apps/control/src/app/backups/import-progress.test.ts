// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The pollable worker record preserves stage time, throttles bytes and counts consumed source bytes. */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { PROGRESS_REFUSED, progressRefused } from '../../testing/world-imports.ts'
import { ImportProgress } from './import-progress.ts'

let h: Harness
const epoch = Date.parse('2026-11-02T12:00:00Z')
const at = (ms: number) => setSystemTime(new Date(epoch + ms))
const read = async (id: string) =>
  (await h.db.query.worldImports.findFirst({ where: eq(schema.worldImports.id, id) }))?.progress
async function reading() {
  const owner = await h.user('Progress')
  const id = randomUUID()
  await h.db
    .insert(schema.worldImports)
    .values({ id, ownerId: owner.userId, fileName: 'Life.tar', sizeBytes: 100 })
  return { id, progress: new ImportProgress(h.db, id) }
}

describe.skipIf(!hasDatabase)('world import measurements', () => {
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })
  afterEach(() => setSystemTime())

  test('stage history and timestamps survive throttled reports and a retry starts a fresh attempt', async () => {
    const { id, progress } = await reading()
    at(0)
    await progress.bytes(10)
    expect(await read(id)).toBeNull()
    await progress.step('fetching', 100)
    const first = await read(id)
    expect(first).toEqual({
      step: 'fetching',
      startedAt: new Date(epoch).toISOString(),
      updatedAt: new Date(epoch).toISOString(),
      bytes: 0,
      totalBytes: 100,
      steps: [{ step: 'fetching', at: new Date(epoch).toISOString() }],
    })
    at(SECOND_MS)
    await progress.bytes(10)
    expect(await read(id)).toEqual(first)
    at(2 * SECOND_MS - 1)
    await progress.bytes(20)
    expect(await read(id)).toEqual(first)
    at(2 * SECOND_MS)
    await progress.bytes(30)
    expect(await read(id)).toMatchObject({
      bytes: 30,
      updatedAt: new Date(epoch + 2 * SECOND_MS).toISOString(),
    })
    at(2 * SECOND_MS + 1)
    await progress.bytes(100)
    expect((await read(id))?.bytes).toBe(100)
    at(3 * SECOND_MS)
    await progress.step('checking')
    expect(await read(id)).toEqual({
      step: 'checking',
      startedAt: new Date(epoch).toISOString(),
      updatedAt: new Date(epoch + 3 * SECOND_MS).toISOString(),
      bytes: 0,
      totalBytes: null,
      steps: [
        { step: 'fetching', at: new Date(epoch).toISOString() },
        { step: 'checking', at: new Date(epoch + 3 * SECOND_MS).toISOString() },
      ],
    })
    await new ImportProgress(h.db, id).step('fetching', 100)
    const retry = await read(id)
    expect(retry?.startedAt).toBe(new Date(epoch + 3 * SECOND_MS).toISOString())
    expect(retry?.steps).toHaveLength(1)
    await h.db.update(schema.worldImports).set({ status: 'ready' }).where(eq(schema.worldImports.id, id))
    at(8 * SECOND_MS)
    await progress.bytes(90)
    expect(await read(id)).toEqual(retry)
  })

  test('packing counts byte arrays and streamed chunks without changing their files', async () => {
    const { id, progress } = await reading()
    await progress.step('packing', 8)
    const source = async function* () {
      yield { name: 'level.dat', sizeBytes: 2, data: new Uint8Array([1, 2]) }
      yield {
        name: 'region/r.0.0.mca',
        sizeBytes: 6,
        data: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([3, 4, 5]))
            controller.enqueue(new Uint8Array([6, 7, 8]))
            controller.close()
          },
        }),
      }
    }
    const files = []
    for await (const entry of progress.entries(source()))
      files.push({
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        bytes: [
          ...(entry.data instanceof Uint8Array
            ? entry.data
            : new Uint8Array(await new Response(entry.data).arrayBuffer())),
        ],
      })
    expect(files).toEqual([
      { name: 'level.dat', sizeBytes: 2, bytes: [1, 2] },
      { name: 'region/r.0.0.mca', sizeBytes: 6, bytes: [3, 4, 5, 6, 7, 8] },
    ])
    expect(await read(id)).toMatchObject({ step: 'packing', bytes: 8, totalBytes: 8 })
  })

  test('a write Postgres refuses is logged and skipped, never thrown, and the next one is written', async () => {
    const { id, progress } = await reading()
    const allow = await progressRefused(h)
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      at(0)
      await progress.step('fetching', 4)
      await progress.bytes(4)
      const source = async function* () {
        yield { name: 'level.dat', sizeBytes: 4, data: new Uint8Array([1, 2, 3, 4]) }
      }
      for await (const entry of progress.entries(source())) expect(entry.name).toBe('level.dat')
      expect(await read(id)).toBeNull()
      expect(warned).toHaveBeenCalledTimes(3)
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`world-import ${id}: progress not written`))
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(PROGRESS_REFUSED))
    } finally {
      warned.mockRestore()
      await allow()
    }
    await progress.step('checking')
    expect(await read(id)).toMatchObject({
      step: 'checking',
      steps: [{ step: 'fetching' }, { step: 'checking' }],
    })
  })
})
