// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A delete that waits to be sent: the time to undo, an undo, leaving the page, and a refusal. */

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { UNDO_MS, UndoableDeletes } from './undoable-delete'

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('a delete that waits to be sent', () => {
  test('is hidden at once and sent only when the time to undo ends', async () => {
    const deletes = new UndoableDeletes()
    const sent: boolean[] = []
    deletes.start('a', async (leaving) => void sent.push(leaving))
    expect(deletes.isWaiting('a')).toBe(true)

    jest.advanceTimersByTime(UNDO_MS - 1)
    expect(sent).toEqual([])
    expect(deletes.isWaiting('a')).toBe(true)

    jest.advanceTimersByTime(1)
    await Promise.resolve()
    expect(sent).toEqual([false])
    expect(deletes.isWaiting('a')).toBe(false)
  })

  test('an undo brings it back and nothing is ever sent', () => {
    const deletes = new UndoableDeletes()
    let sent = 0
    deletes.start('a', async () => {
      sent += 1
    })
    jest.advanceTimersByTime(UNDO_MS - 1000)
    deletes.undo('a')
    jest.advanceTimersByTime(UNDO_MS * 2)
    expect(sent).toBe(0)
    expect(deletes.isWaiting('a')).toBe(false)
  })

  test('leaving the page sends what is waiting at once, marked as leaving, and only once', async () => {
    const deletes = new UndoableDeletes()
    const sent: boolean[] = []
    deletes.start('a', async (leaving) => void sent.push(leaving))
    deletes.start('b', async (leaving) => void sent.push(leaving))
    deletes.undo('b')
    deletes.leave()
    await Promise.resolve()
    expect(sent).toEqual([true])
    jest.advanceTimersByTime(UNDO_MS * 2)
    expect(sent).toEqual([true])
  })

  test('leaving twice, or after the timer fired, sends it once', async () => {
    const deletes = new UndoableDeletes()
    let sent = 0
    deletes.start('a', async () => {
      sent += 1
    })
    deletes.leave()
    deletes.leave()
    await Promise.resolve()
    expect(sent).toBe(1)

    deletes.start('b', () => new Promise(() => {}))
    jest.advanceTimersByTime(UNDO_MS)
    deletes.leave()
    deletes.leave()
    expect(deletes.isWaiting('b')).toBe(true)
    jest.advanceTimersByTime(UNDO_MS)
    expect(sent).toBe(1)
  })

  test('a delete the API refused is kept with what it said, and the note is no longer hidden', async () => {
    const deletes = new UndoableDeletes()
    const failure = new Error('Cubepals couldn’t be reached.')
    deletes.start('a', async () => {
      throw failure
    })
    jest.advanceTimersByTime(UNDO_MS)
    await Promise.resolve()
    await Promise.resolve()
    expect(deletes.isWaiting('a')).toBe(false)
    expect(deletes.refusal('a')).toEqual({ error: failure })

    deletes.start('a', async () => {})
    expect(deletes.refusal('a')).toBeUndefined()
  })

  test('tells whoever is watching when it changes', () => {
    const deletes = new UndoableDeletes()
    let heard = 0
    const stop = deletes.subscribe(() => {
      heard += 1
    })
    const before = deletes.snapshot()
    deletes.start('a', async () => {})
    deletes.undo('a')
    expect(heard).toBe(2)
    expect(deletes.snapshot()).not.toBe(before)
    stop()
    deletes.start('a', async () => {})
    expect(heard).toBe(2)
  })
})
