// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files evidence must account for, independently of what the tests imported. Every tracked
 * JavaScript/TypeScript module in the application, packages, scripts and tools is classified by syntax.
 * Generated code and test support have no directory exemption; executable code counts there too.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { resolveImport } from './mutation-resolve.mjs'
import { parse } from './toolchain.mjs'

export function fileHash(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function parseSource(text, path) {
  try {
    return parse(text, {
      sourceType: 'unambiguous',
      sourceFilename: path,
      plugins: [
        ...(/\.[cm]?tsx?$/.test(path) ? ['typescript'] : []),
        ...(/\.[jt]sx$/.test(path) ? ['jsx'] : []),
        'importAttributes',
      ],
    })
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error })
  }
}

function declaration(node) {
  if (node.declare) return true
  if (['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'].includes(node.type))
    return true
  if (node.type === 'ImportDeclaration')
    return (
      node.importKind === 'type' ||
      (node.specifiers.length > 0 && node.specifiers.every((item) => item.importKind === 'type'))
    )
  if (node.type === 'ExportNamedDeclaration') {
    if (node.exportKind === 'type') return true
    if (node.declaration) return declaration(node.declaration)
    return node.specifiers.length === 0 || node.specifiers.every((item) => item.exportKind === 'type')
  }
  return node.type === 'EmptyStatement'
}

export function classifySource(text, path, ast = parseSource(text, path)) {
  // These trusted checkers run in Node, with a separately required self-test and defect proof.
  // The base policy pins this entire directory; ordinary PRs cannot add an exemption here.
  if (path.startsWith('scripts/quality/')) return 'infrastructure'
  if (ast.comments?.some((comment) => /\b(?:istanbul|c8|v8|bun)\s+ignore\b/i.test(comment.value)))
    throw new Error(`Coverage suppression is forbidden: ${path}`)
  const isDeclaration = ast.program.body.every(declaration)
  if (/\.d\.[cm]?ts$/.test(path) && !isDeclaration)
    throw new Error(`Declaration file contains executable code: ${path}`)
  if (/(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return 'test'
  return isDeclaration ? 'declaration' : 'source'
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node))
    if (!['loc', 'comments', 'tokens'].includes(key)) walk(value, visit)
}

function constantBindings(ast) {
  const bindings = new Map()
  function add(pattern, value = null) {
    if (!pattern) return
    if (pattern.type === 'Identifier') {
      const definitions = bindings.get(pattern.name) ?? []
      definitions.push(value)
      bindings.set(pattern.name, definitions)
    } else if (pattern.type === 'RestElement') add(pattern.argument)
    else if (pattern.type === 'AssignmentPattern') add(pattern.left)
    else if (pattern.type === 'ArrayPattern') {
      for (const part of pattern.elements) add(part)
    } else if (pattern.type === 'ObjectPattern') {
      for (const part of pattern.properties) add(part.value ?? part.argument)
    }
  }
  walk(ast.program, (node) => {
    if (node.type === 'VariableDeclaration') {
      for (const part of node.declarations) add(part.id, node.kind === 'const' ? part.init : null)
    }
    if (node.params) for (const parameter of node.params) add(parameter)
    if (
      ['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type)
    )
      add(node.id)
    if (node.type === 'ImportDeclaration') for (const part of node.specifiers) add(part.local)
    if (node.type === 'CatchClause') add(node.param)
    if (node.type === 'AssignmentExpression') add(node.left)
    if (node.type === 'UpdateExpression') add(node.argument)
  })
  return bindings
}

function constantString(node, bindings, resolving = new Set()) {
  if (!node) return undefined
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'Identifier') {
    const definitions = bindings.get(node.name)
    if (definitions?.length !== 1 || resolving.has(node.name)) return undefined
    return constantString(definitions[0], bindings, new Set([...resolving, node.name]))
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = constantString(node.left, bindings, resolving)
    const right = constantString(node.right, bindings, resolving)
    return left === undefined || right === undefined ? undefined : left + right
  }
  if (node.type === 'TemplateLiteral') {
    let value = node.quasis[0].value.cooked
    for (let i = 0; i < node.expressions.length; i++) {
      const part = constantString(node.expressions[i], bindings, resolving)
      if (part === undefined) return undefined
      value += part + node.quasis[i + 1].value.cooked
    }
    return value
  }
  return undefined
}

export function runtimeImports(ast) {
  const imports = new Set()
  const bindings = constantBindings(ast)
  walk(ast.program, (node) => {
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      const typeOnly =
        node.importKind === 'type' ||
        node.exportKind === 'type' ||
        (node.specifiers?.length > 0 &&
          node.specifiers.every((part) => part.importKind === 'type' || part.exportKind === 'type'))
      if (!typeOnly && node.source?.type === 'StringLiteral') imports.add(node.source.value)
    }
    const dynamic =
      node.type === 'ImportExpression'
        ? node.source
        : node.type === 'CallExpression' &&
            (node.callee?.type === 'Import' || node.callee?.name === 'require')
          ? node.arguments[0]
          : null
    if (!dynamic) return
    const value = constantString(dynamic, bindings)
    if (typeof value !== 'string')
      throw new Error('Unresolved dynamic module import; use an unambiguous constant module path')
    imports.add(value)
  })
  return [...imports]
}

export function inventory(root) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => /^(?:apps|packages|scripts|tools)\/.*\.(?:[cm]?[jt]s|[jt]sx)$/.test(path))
  const imports = new Map()
  const entries = [...new Set(names)].sort().map((path) => {
    const absolute = resolve(root, path)
    if (!lstatSync(absolute).isFile()) throw new Error(`Source must be a regular file: ${path}`)
    const text = readFileSync(absolute, 'utf8')
    const ast = parseSource(text, path)
    const kind = classifySource(text, path, ast)
    if (kind === 'source') {
      try {
        imports.set(path, runtimeImports(ast))
      } catch (error) {
        throw new Error(`${path}: ${error.message}`, { cause: error })
      }
    }
    return { path, sha256: fileHash(text), kind }
  })
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  for (const [path, specifiers] of imports) {
    for (const specifier of specifiers) {
      // OpenNext creates this exact module during worker:build. CI's required Worker smoke job
      // exercises that build output; it is not source that can exist in the source inventory.
      if (
        path === 'apps/web/worker.ts' &&
        specifier.startsWith('.') &&
        relative(root, resolve(root, dirname(path), specifier)) === 'apps/web/.open-next/worker.js'
      )
        continue
      const target = resolveImport(root, path, specifier)
      const entry = byPath.get(target)
      if (entry && ['test', 'infrastructure'].includes(entry.kind))
        throw new Error(`Production source ${path} imports excluded ${entry.kind} ${target}`)
      if (target && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(target) && !entry)
        throw new Error(`Production source ${path} imports code outside the inventory: ${target}`)
    }
  }
  return entries
}

export function sourceFiles(entries) {
  return entries.filter((entry) => entry.kind === 'source').map((entry) => entry.path)
}
