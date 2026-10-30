// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selects mutation subjects from source changes and the dependencies of changed tests. Imports
 * are parsed, including re-exports and literal dynamic imports; ambiguous local loading falls
 * back to the complete inventory. A test-only change therefore cannot opt out of mutation work.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseSource } from './inventory.mjs'
import { resolveImport } from './mutation-resolve.mjs'

/** Seven disjoint stable partitions visit the complete source inventory over a scheduled week. */
export function rotationSubjects(subjects, rotation) {
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 6)
    throw new Error('Rotation must be an integer from 0 to 6')
  return subjects.filter(
    (subject) => createHash('sha256').update(subject).digest().readUInt32BE(0) % 7 === rotation,
  )
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc' && key !== 'comments' && key !== 'tokens') walk(value, visit)
  }
}

function references(text, file) {
  const ast = parseSource(text, file)
  const constants = new Map()
  const bindings = new Map()
  const bind = (pattern) =>
    walk(pattern, (node) => {
      if (node.type === 'Identifier') bindings.set(node.name, (bindings.get(node.name) ?? 0) + 1)
    })
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') bind(node.id)
    if (Array.isArray(node.params)) for (const parameter of node.params) bind(parameter)
    if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const declaration of node.declarations) {
        if (declaration.id.type === 'Identifier' && declaration.init?.type === 'StringLiteral')
          constants.set(declaration.id.name, declaration.init.value)
      }
    }
  })
  for (const name of constants.keys()) if (bindings.get(name) !== 1) constants.delete(name)
  const imports = new Set()
  let ambiguous = false
  walk(ast, (node) => {
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source?.value &&
      node.importKind !== 'type' &&
      node.exportKind !== 'type' &&
      !(
        node.type === 'ImportDeclaration' &&
        node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => specifier.importKind === 'type')
      )
    )
      imports.add(node.source.value)
    const dynamic =
      node.type === 'ImportExpression'
        ? node.source
        : node.type === 'CallExpression' &&
            (node.callee.type === 'Import' ||
              (node.callee.type === 'Identifier' && node.callee.name === 'require'))
          ? node.arguments[0]
          : null
    if (!dynamic) return
    const value =
      dynamic.type === 'StringLiteral'
        ? dynamic.value
        : dynamic.type === 'Identifier'
          ? constants.get(dynamic.name)
          : dynamic.type === 'TemplateLiteral' && dynamic.expressions.length === 0
            ? dynamic.quasis[0]?.value.cooked
            : undefined
    if (typeof value === 'string') imports.add(value)
    else ambiguous = true
  })
  return { imports: [...imports], ambiguous }
}

export function dependencyGraph(root, files) {
  const known = new Set(files)
  const graph = new Map()
  const ambiguous = new Set()
  for (const file of files) {
    const refs = references(readFileSync(resolve(root, file), 'utf8'), file)
    const dependencies = new Set()
    if (refs.ambiguous) ambiguous.add(file)
    for (const specifier of refs.imports) {
      try {
        const dependency = resolveImport(root, file, specifier)
        if (known.has(dependency)) dependencies.add(dependency)
      } catch {
        ambiguous.add(file)
      }
    }
    graph.set(file, dependencies)
  }
  return { graph, ambiguous }
}

function closure(graph, start) {
  const seen = new Set()
  const pending = [start]
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    pending.push(...(graph.get(file) ?? []))
  }
  return seen
}

export function selectMutationScope({
  root,
  productionFiles,
  testFiles,
  changedFiles,
  full = false,
  ignoredConfigFiles = new Set(),
}) {
  if (full && productionFiles.length === 0) throw new Error('Full mutation inventory is empty')
  const source = new Set(productionFiles)
  const tests = new Set(testFiles)
  const changed = new Set(changedFiles)
  const { graph, ambiguous } = dependencyGraph(root, [...source, ...tests])
  const testDependencies = new Map(testFiles.map((file) => [file, closure(graph, file)]))
  const reasons = []
  if (full) reasons.push('full inventory requested')
  if (
    changedFiles.some(
      (file) =>
        !file.startsWith('tools/quality/') &&
        !ignoredConfigFiles.has(file) &&
        /(?:^|\/)(?:package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json)$/.test(file),
    )
  ) {
    full = true
    reasons.push('dependency or resolution configuration changed')
  }
  const subjects = new Set(changedFiles.filter((file) => source.has(file)))
  for (const file of changedFiles) {
    if (tests.has(file)) {
      for (const dependency of testDependencies.get(file) ?? []) {
        if (source.has(dependency)) subjects.add(dependency)
      }
    }
    if (
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !tests.has(file) &&
      !file.startsWith('scripts/quality/') &&
      !file.startsWith('tools/quality/')
    ) {
      full = true
      reasons.push(`test removed: ${file}`)
    }
  }
  for (const file of [...subjects, ...changedFiles.filter((path) => tests.has(path))]) {
    if ([...closure(graph, file)].some((dependency) => ambiguous.has(dependency))) {
      full = true
      reasons.push(`ambiguous dependency mapping: ${file}`)
    }
  }
  if (full) for (const file of source) subjects.add(file)
  if (subjects.size === 0 && changedFiles.some((file) => tests.has(file))) {
    throw new Error('Changed tests have no mutation subjects; refusing an empty mutation run')
  }
  const testsByFile = Object.fromEntries(
    [...subjects].sort().map((file) => {
      const direct = testFiles.filter((test) => graph.get(test)?.has(file))
      const dependents = testFiles.filter((test) => {
        const dependencies = testDependencies.get(test)
        return dependencies.has(file) || [...dependencies].some((dependency) => ambiguous.has(dependency))
      })
      // Fewer tests can only leave more mutants alive, never inflate the kill score. Adjacent
      // subject tests and changed dependent tests avoid repeating unrelated integration suites.
      const stem = basename(file).replace(/\.[cm]?[jt]sx?$/, '')
      const adjacent = direct.filter((test) => basename(test).startsWith(`${stem}.`))
      const focused = [...adjacent, ...dependents.filter((test) => changed.has(test))]
      return [file, [...new Set(focused.length ? focused : direct.length ? direct : dependents)].sort()]
    }),
  )
  return { subjects: [...subjects].sort(), testsByFile, full, reasons, changedFiles: [...changed] }
}
