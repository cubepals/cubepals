import { afterEach, describe, expect, test } from 'bun:test'
import { newId } from './ids.ts'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  const original = crypto.randomUUID
  afterEach(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
  })

  test('is a version 4 UUID in a secure context', () => {
    expect(newId()).toMatch(V4)
  })

  // A page opened at a network address is not a secure context, and has no randomUUID.
  test('is still a version 4 UUID where randomUUID is missing, and never the same twice', () => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    const ids = new Set(Array.from({ length: 1000 }, () => newId()))
    expect(ids.size).toBe(1000)
    for (const id of ids) expect(id).toMatch(V4)
  })
})
