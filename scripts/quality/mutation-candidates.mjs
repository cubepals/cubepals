// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Independently enumerate every pinned Stryker candidate, with no exclusions or custom plugins. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requireQuality } from './toolchain.mjs'

const coreRequire = createRequire(requireQuality.resolve('@stryker-mutator/core/package.json'))
const { Instrumenter } = await import(
  pathToFileURL(coreRequire.resolve('@stryker-mutator/instrumenter')).href
)
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  isDebugEnabled: () => false,
}
const instrumenter = new Instrumenter(logger)
const sources = {}
for (const subject of input.subjects) {
  const content = readFileSync(resolve(input.root, subject), 'utf8')
  const result = await instrumenter.instrument(
    [{ name: resolve(input.root, subject), mutate: true, content }],
    { excludedMutations: [], plugins: null, ignorers: [] },
  )
  sources[subject] = {
    count: result.mutants.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}
writeFileSync(input.output, JSON.stringify(sources, null, 2))
