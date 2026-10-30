// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quality tools have their own pinned installation, as the OpenAPI tooling does. Resolving from
 * that manifest keeps instrumentation and mutation dependencies out of the application's hoisted
 * dependency graph: adding a test tool must not activate a previously absent application peer.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const requireQuality = createRequire(new URL('../../tools/quality/package.json', import.meta.url))
const directory = fileURLToPath(new URL('../../tools/quality/node_modules/', import.meta.url))
for (const name of ['@babel/parser', 'istanbul-lib-instrument', 'fast-xml-parser', '@stryker-mutator/core']) {
  if (!requireQuality.resolve(name).startsWith(directory))
    throw new Error(`Quality tool ${name} is not isolated; run bun run quality:install`)
}
let parser
let instrumenter
export function parse(...args) {
  parser ??= requireQuality('@babel/parser').parse
  return parser(...args)
}
export function createInstrumenter(...args) {
  instrumenter ??= requireQuality('istanbul-lib-instrument').createInstrumenter
  return instrumenter(...args)
}
export const { XMLParser, XMLValidator } = requireQuality('fast-xml-parser')
