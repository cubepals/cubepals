// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Resolves runtime imports within a checkout, including Bun workspaces and extensionless TS. */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

const workspaceCache = new Map()

function workspaces(root) {
  if (workspaceCache.has(root)) return workspaceCache.get(root)
  const result = new Map()
  for (const directory of ['apps', 'packages']) {
    const parent = resolve(root, directory)
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent)) {
      const manifest = resolve(parent, entry, 'package.json')
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (pkg.name) result.set(pkg.name, { directory: dirname(manifest), pkg })
    }
  }
  workspaceCache.set(root, result)
  return result
}

function runtimeExport(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const condition of ['bun', 'node', 'import', 'default']) {
      const selected = runtimeExport(value[condition])
      if (selected) return selected
    }
  }
  return null
}

function localFile(root, base) {
  const suffix = extname(base)
  const candidates = [
    base,
    ...[
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '/index.ts',
      '/index.tsx',
      '/index.js',
    ].map((s) => base + s),
  ]
  if (['.js', '.mjs', '.cjs'].includes(suffix))
    candidates.push(`${base.slice(0, -suffix.length)}.ts`, `${base.slice(0, -suffix.length)}.tsx`)
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!found) throw new Error(`Cannot resolve local import ${base}`)
  const path = relative(root, found)
  if (path.startsWith('../')) throw new Error(`Import escapes the checkout: ${base}`)
  return path
}

export function resolveImport(root, importer, specifier) {
  if (/^(?:node:|bun:)/.test(specifier)) return null
  const from = resolve(root, importer)
  if (specifier.startsWith('.') || isAbsolute(specifier))
    return localFile(root, resolve(dirname(from), specifier))
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  const workspace = workspaces(root).get(name)
  if (workspace) {
    const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`
    const exports = workspace.pkg.exports
    const exported =
      typeof exports === 'string' && subpath === '.'
        ? exports
        : (runtimeExport(exports?.[subpath]) ??
          (subpath === '.' ? (runtimeExport(exports) ?? workspace.pkg.main) : null))
    if (!exported) throw new Error(`Workspace export not found: ${specifier}`)
    return localFile(root, resolve(workspace.directory, exported))
  }
  try {
    const found =
      typeof Bun === 'undefined'
        ? createRequire(from).resolve(specifier)
        : Bun.resolveSync(specifier, dirname(from))
    if (!isAbsolute(found)) return null
    const path = relative(root, realpathSync(found))
    return path.startsWith('../') || /(?:^|\/)node_modules\//.test(path) ? null : path
  } catch (error) {
    if (specifier.startsWith('@blockly/')) throw error
    return null
  }
}
