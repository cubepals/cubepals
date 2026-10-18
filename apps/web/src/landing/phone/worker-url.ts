// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Where a worker's start-up settings travel. Turbopack puts them in the worker URL's hash
 * (`#params=...`), and the worker's first script parses everything after `#params=`. A browser
 * that adds a fragment of its own to the worker's address (Meta's in-app browser does) leaves that
 * parse reading the browser's text as well, and the worker never starts. The same script reads
 * `?params=` before it reads the hash, and a fragment added after the query changes nothing in it,
 * so the settings are moved there. Not for starting the worker, which is Still.tsx.
 */

/** The same address with `#params=...` moved into the query; one without them as it was. */
export function paramsInQuery(url: URL): URL {
  if (!url.hash.startsWith('#params=')) return url
  const moved = new URL(url)
  moved.searchParams.set('params', decodeURIComponent(url.hash.slice('#params='.length)))
  moved.hash = ''
  return moved
}

/**
 * What `start` makes, with every worker it starts meanwhile given its settings in the query. The
 * build turns `new Worker(new URL(...))` into a call that builds the address and uses whatever
 * `Worker` is then, so for the length of `start` that is a Worker that moves the settings, and the
 * browser's own again after.
 */
export function withParamsInQuery<T>(start: () => T): T {
  const Original = globalThis.Worker
  globalThis.Worker = class extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url instanceof URL ? paramsInQuery(url) : url, options)
    }
  }
  try {
    return start()
  } finally {
    globalThis.Worker = Original
  }
}
