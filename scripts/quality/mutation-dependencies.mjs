// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Parses runtime dependencies without executing proposed source or following test-name conventions. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSource } from './inventory.mjs'
import { resolveImport } from './mutation-resolve.mjs'

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

/** Every literal module specifier a file loads at runtime, and whether any load is unresolvable. */
export function references(text, file) {
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
  const templates = []
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
    else {
      ambiguous = true
      // A relative template can only name local files: keep its fixed ends for callers that can
      // enumerate them. Every caller still sees the load as ambiguous.
      const quasis = dynamic.type === 'TemplateLiteral' ? dynamic.quasis : []
      const prefix = quasis[0]?.value.cooked
      if (/^\.\.?\//.test(prefix ?? '')) templates.push({ prefix, suffix: quasis.at(-1).value.cooked })
      else templates.push(null)
    }
  })
  return { imports: [...imports], ambiguous, templates }
}

export function dependencyGraph(root, files, { includeData = false } = {}) {
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
        if (known.has(dependency) || (includeData && /\.(?:json|css|html)$/.test(dependency ?? '')))
          dependencies.add(dependency)
      } catch {
        ambiguous.add(file)
      }
    }
    graph.set(file, dependencies)
  }
  return { graph, ambiguous }
}
