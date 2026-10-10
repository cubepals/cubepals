// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Fails on any use of something marked @deprecated. Run: bun run check:deprecated
//
// TypeScript already works out every deprecation — it is what draws the strikethrough in an
// editor — but `tsc` only prints errors, and a deprecation is a suggestion. This asks the
// compiler for its suggestions and keeps the ones it marks deprecated, so the answer is
// TypeScript's own, for methods, properties, types and signatures alike. Biome's
// `noDeprecatedImports` sees only imports, which misses `queryClient.prefetchQuery` and
// `React.FormEvent`; `@typescript-eslint/no-deprecated` would bring a second linter for one rule.
//
// It runs under Node: TypeScript 7's API reads a stream's file descriptor, which Bun doesn't
// expose.
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { API } from 'typescript/unstable/sync'
import { CONFIGS } from './typecheck-projects.ts'

const root = resolve(import.meta.dirname, '..')
const api = new API({ cwd: root })
const configs = CONFIGS.map((config) => resolve(root, config))
const snapshot = api.updateSnapshot({ openProjects: configs })

const found = new Map<string, string>()
for (const config of configs) {
  const project = snapshot.getProject(config)
  if (project === undefined) throw new Error(`TypeScript did not open ${config}`)
  for (const diagnostic of project.program.getSuggestionDiagnostics()) {
    const file = diagnostic.fileName
    // Only what Blockly writes: a generated client repeats its spec, deprecated parts and all.
    if (!diagnostic.reportsDeprecated || file === undefined || /\/(node_modules|generated)\//.test(file))
      continue
    const before = readFileSync(file, 'utf8').slice(0, diagnostic.pos).split('\n')
    const where = `${relative(root, file)}:${before.length}:${(before.at(-1)?.length ?? 0) + 1}`
    // Projects share files (a package is in every app that imports it): each place once.
    found.set(where, diagnostic.text)
  }
}
api.close()

for (const [where, text] of [...found].sort(([a], [b]) => a.localeCompare(b)))
  console.error(`${where}  ${text}`)
console.warn(
  found.size === 0 ? 'ok   nothing deprecated in use' : `FAIL ${found.size} uses of something deprecated`,
)
process.exit(found.size === 0 ? 0 : 1)
