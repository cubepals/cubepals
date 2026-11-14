// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/** A worker's settings survive a fragment the browser adds to its address. */
import { describe, expect, test } from 'bun:test'
import { paramsInQuery, withParamsInQuery } from './worker-url'

const SETTINGS = JSON.stringify([['static/chunks/a.js'], '', '/_next/', 'dpl', ''])
const turbopack = () => {
  const url = new URL('https://cubepals.com/_next/static/chunks/turbopack-worker-x.js')
  url.hash = `#params=${encodeURIComponent(SETTINGS)}`
  return url
}

/** What the worker's first script does to read them: the query first, then the hash. */
function bootstrap(url: URL): unknown {
  const found = url.searchParams.get('params') ?? decodeURIComponent(url.hash.slice('#params='.length))
  return JSON.parse(found)
}

describe('a worker address', () => {
  test('with a fragment added after Turbopack settings in the hash, the worker cannot read them', () => {
    const url = turbopack()
    url.hash += `#${JSON.stringify({ navigator: { userAgent: 'Instagram' } })}`
    expect(() => bootstrap(url)).toThrow(SyntaxError)
  })

  test('with the settings moved to the query, a fragment added after changes nothing', () => {
    const url = paramsInQuery(turbopack())
    url.hash = `#${JSON.stringify({ navigator: { userAgent: 'Instagram' } })}`
    expect(bootstrap(url)).toEqual(JSON.parse(SETTINGS))
  })

  test('an address without settings in its hash is left as it is', () => {
    const url = new URL('https://cubepals.com/w.js?params=%5B%5D')
    expect(paramsInQuery(url)).toBe(url)
  })
})

describe('starting a worker', () => {
  test('every worker started meanwhile gets its settings in the query, and the browser’s own Worker is back after', () => {
    const made: string[] = []
    const Original = globalThis.Worker
    globalThis.Worker = class {
      constructor(url: string | URL) {
        made.push(String(url))
      }
    } as unknown as typeof Worker
    const stand = globalThis.Worker
    try {
      withParamsInQuery(() => new Worker(turbopack()))
      expect(made).toHaveLength(1)
      expect(made[0]).toContain('?params=')
      expect(made[0]).not.toContain('#')
      expect(globalThis.Worker).toBe(stand)
    } finally {
      globalThis.Worker = Original
    }
  })

  test('the browser’s Worker is back when starting throws', () => {
    const Original = globalThis.Worker
    globalThis.Worker = class {} as unknown as typeof Worker
    const stand = globalThis.Worker
    try {
      expect(() =>
        withParamsInQuery(() => {
          throw new Error('refused')
        }),
      ).toThrow('refused')
      expect(globalThis.Worker).toBe(stand)
    } finally {
      globalThis.Worker = Original
    }
  })
})
