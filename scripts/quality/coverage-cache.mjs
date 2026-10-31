// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writes compiled modules once and gives each isolated Bun realm a small, hashed manifest.
 * Zero-hit maps stay in the trusted parent; Bun reads and verifies only modules it imports.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function writeRuntimeManifest(prepared, directory) {
  const compiled = join(directory, 'compiled')
  mkdirSync(compiled)
  const modules = {}
  for (const [path, contents] of Object.entries(prepared.contents)) {
    const file = `${createHash('sha256').update(path).digest('hex')}.js`
    const sha256 = createHash('sha256').update(contents).digest('hex')
    writeFileSync(join(compiled, file), contents, { flag: 'wx' })
    modules[path] = { file, sha256 }
  }
  const runtime = {
    version: prepared.version,
    root: prepared.root,
    runId: prepared.runId,
    inventory: prepared.inventory,
    tests: prepared.tests,
    modules,
  }
  const bytes = `${JSON.stringify(runtime)}\n`
  const path = join(directory, 'runtime.json')
  writeFileSync(path, bytes, { flag: 'wx' })
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}
