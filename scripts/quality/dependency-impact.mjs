// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Judges a dependency-only update by what it can break. A change qualifies only when every changed
 * file is `bun.lock` or a `package.json`, manifests differ only in registry version specs of
 * dependencies they already declare, and every changed lock record is a registry tarball with an
 * integrity hash. Source and tests are then byte-identical, so no new code exists to hold to the
 * new-code floor. Two things can still change: runtime behavior, which the complete suite and the
 * coverage ratchet already judge, and the strength of test oracles, when a test (or a module only
 * tests reach) loads an updated package. Those tests' source closures are held to the mutation
 * score the same tests reach on the base revision with the base lockfile.
 *
 * Not for: deciding what a mixed change owes. Anything else in the diff, or any record this module
 * cannot prove, leaves the caller's conservative full-scope rules in force.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { dependencyKey, equal, packageChain, packageDependencies } from './config-impact.mjs'
import { liveFleet } from './evidence-policy.mjs'
import { dependencyGraph, references } from './mutation-dependencies.mjs'
import { parseLock } from './policy.mjs'

const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const MANIFEST = /^(?:(?:apps|packages)\/[^/]+\/)?package\.json$/
const REGISTRY_SPEC = /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/
// Read by GitHub to schedule updates; no build, test or runtime loads it.
const INERT = new Set(['.github/dependabot.yml'])

function withoutGroups(manifest) {
  const result = structuredClone(manifest)
  for (const group of GROUPS) delete result[group]
  return result
}

/** Same names in every group; any changed spec moves between two exact or caret/tilde versions. */
function onlyVersionsMoved(before, after, where) {
  if (!equal(withoutGroups(before), withoutGroups(after))) return `${where}: more than versions changed`
  for (const group of GROUPS) {
    const old = before[group] ?? {}
    const next = after[group] ?? {}
    if (!equal(Object.keys(old).sort(), Object.keys(next).sort()))
      return `${where}: ${group} adds or removes a package`
    for (const [name, spec] of Object.entries(next)) {
      if (spec === old[name]) continue
      if (!REGISTRY_SPEC.test(spec) || !REGISTRY_SPEC.test(old[name]))
        return `${where}: ${name} is not a registry version (${old[name]} -> ${spec})`
    }
  }
  return null
}

function registryRecord(key, record) {
  if (!Array.isArray(record) || record.length !== 4 || record[1] !== '') return false
  if (typeof record[3] !== 'string' || !INTEGRITY.test(record[3])) return false
  const name = packageChain(key).at(-1)
  const id = record[0]
  return (
    typeof id === 'string' &&
    id.startsWith(`${name}@`) &&
    REGISTRY_SPEC.test(id.slice(name.length + 1)) &&
    !/^[~^]/.test(id.slice(name.length + 1))
  )
}

// Scripts a package manager runs while installing a package.
const INSTALL_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
])

// Files a package can ship without any of them ever running. Other JSON is data a test can import.
const DECLARATION =
  /(?:\.d\.[cm]?ts|\.d\.ts\.map|(?:^|\/)package\.json|\.(?:mdx?|markdown|txt))$|(?:^|\/)(?:licen[cs]e|notice|readme|changelog|authors)[^/]*$/i

/** Where the hoisted install puts a lock key, in the root or under the workspace that owns it. */
function installedDirectory(root, lock, key) {
  const chain = packageChain(key)
  const workspace = Object.entries(lock.workspaces).find(
    ([path, manifest]) => path && manifest.name === chain[0],
  )?.[0]
  const [prefix, rest] = workspace ? [workspace, chain.slice(1)] : ['', chain]
  return join(root, prefix, 'node_modules', rest.join('/node_modules/'))
}

/**
 * True only when the installed copy is this exact version and holds nothing but type declarations
 * and documents. Missing, different or unreadable installs are not proved inert.
 */
function declarationsOnly(root, lock, key) {
  try {
    const directory = installedDirectory(root, lock, key)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (`${manifest.name}@${manifest.version}` !== lock.packages[key][0]) return false
    // An install script runs without being a shipped file the walk below could see.
    const scripts = Object.keys(manifest.scripts ?? {})
    if (manifest.bin || scripts.some((name) => INSTALL_SCRIPTS.has(name))) return false
    const pending = ['']
    while (pending.length) {
      const relative = pending.pop()
      for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') pending.push(path)
        } else if (!entry.isFile() || !DECLARATION.test(path)) return false
      }
    }
    return existsSync(directory)
  } catch {
    return false
  }
}

/** Every package name whose resolved graph, in either revision, contains a changed record. */
function affectedNames(beforeLock, afterLock, changedKeys) {
  const names = new Set()
  for (const lock of [beforeLock, afterLock]) {
    const parents = new Map()
    for (const key of Object.keys(lock.packages)) {
      for (const { name } of packageDependencies(lock.packages[key])) {
        const child = dependencyKey(lock, key, name)
        if (!child) continue
        if (!parents.has(child)) parents.set(child, new Set())
        parents.get(child).add(key)
      }
    }
    const pending = changedKeys.filter((key) => Object.hasOwn(lock.packages, key))
    const seen = new Set(pending)
    while (pending.length) {
      const key = pending.pop()
      for (const parent of parents.get(key) ?? []) {
        if (seen.has(parent)) continue
        seen.add(parent)
        pending.push(parent)
      }
    }
    for (const key of seen) names.add(packageChain(key).at(-1))
  }
  for (const key of changedKeys) names.add(packageChain(key).at(-1))
  return names
}

/**
 * Proves a dependency-only change from Git objects and the committed head, or says why not.
 * Returns `{ eligible: true, files, changedPackages, affectedPackages }` or `{ eligible: false, reason }`.
 */
export function dependencyOnlyChange(root, baseSha, changedFiles) {
  const refuse = (reason) => ({ eligible: false, reason })
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? '') || !Array.isArray(changedFiles) || !changedFiles.length)
    return refuse('no verified comparison')
  const other = changedFiles.filter((path) => path !== 'bun.lock' && !MANIFEST.test(path) && !INERT.has(path))
  if (other.length) return refuse(`not dependency files: ${other.slice(0, 5).join(', ')}`)
  if (!changedFiles.includes('bun.lock')) return refuse('bun.lock did not change')
  try {
    const before = (path) =>
      execFileSync('git', ['show', `${baseSha}:${path}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
    const after = (path) => {
      const full = resolve(root, path)
      if (!lstatSync(full).isFile()) throw new Error(`${path} is not a regular file`)
      return readFileSync(full, 'utf8')
    }
    for (const path of changedFiles.filter((file) => MANIFEST.test(file))) {
      const reason = onlyVersionsMoved(JSON.parse(before(path)), JSON.parse(after(path)), path)
      if (reason) return refuse(reason)
    }
    const beforeLock = parseLock(before('bun.lock'))
    const afterLock = parseLock(after('bun.lock'))
    const metadata = (lock) =>
      Object.fromEntries(Object.entries(lock).filter(([key]) => !['packages', 'workspaces'].includes(key)))
    if (!equal(metadata(beforeLock), metadata(afterLock)))
      return refuse('bun.lock settings, overrides or patches changed')
    if (!equal(Object.keys(beforeLock.workspaces).sort(), Object.keys(afterLock.workspaces).sort()))
      return refuse('bun.lock workspaces changed')
    for (const [workspace, manifest] of Object.entries(afterLock.workspaces)) {
      const reason = onlyVersionsMoved(beforeLock.workspaces[workspace], manifest, `bun.lock ${workspace}`)
      if (reason) return refuse(reason)
      const declared = JSON.parse(after(workspace ? `${workspace}/package.json` : 'package.json'))
      for (const group of GROUPS)
        if (!equal(declared[group] ?? {}, manifest[group] ?? {}))
          return refuse(`bun.lock disagrees with ${workspace || 'the root'} package.json`)
    }
    const changedKeys = []
    for (const key of new Set([...Object.keys(beforeLock.packages), ...Object.keys(afterLock.packages)])) {
      const old = beforeLock.packages[key]
      const next = afterLock.packages[key]
      if (equal(old, next)) continue
      if (next !== undefined && !registryRecord(key, next))
        return refuse(`${key} does not resolve to a registry tarball with an integrity hash`)
      changedKeys.push(key)
    }
    if (!changedKeys.length) return refuse('no package resolution changed')
    // A removed record, or one whose install holds runnable files, can change what tests load.
    const declarationKeys = changedKeys.filter(
      (key) => afterLock.packages[key] !== undefined && declarationsOnly(root, afterLock, key),
    )
    const runtimeKeys = changedKeys.filter((key) => !declarationKeys.includes(key))
    return {
      eligible: true,
      files: [...changedFiles].sort(),
      changedPackages: changedKeys.sort(),
      declarationPackages: declarationKeys.sort(),
      affectedPackages: [...affectedNames(beforeLock, afterLock, runtimeKeys)].sort(),
    }
  } catch (error) {
    return refuse(`unproved: ${error.message}`)
  }
}

// Next's App Router serves these by file name; no import reaches them, but production runs them.
const NEXT_ENTRY =
  /^apps\/web\/src\/(?:app\/(?:.*\/)?(?:page|layout|route|template|default|loading|error|not-found|global-error)|middleware|instrumentation)\.[jt]sx?$/

function packageName(specifier) {
  if (/^(?:node:|bun:|\.|\/)/.test(specifier)) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function reachable(graph, starts) {
  const seen = new Set()
  const pending = [...starts]
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    pending.push(...(graph.get(file) ?? []))
  }
  return seen
}

/**
 * Tests whose oracle can load an updated package: the test itself, or a module only tests reach,
 * imports it (an unresolvable load counts as one). Modules production also reaches are judged as
 * production: their behavior change is the complete suite's to catch, not a weaker assertion.
 * The live Fleet suites are left out: they skip in every mutation run, on base and head alike,
 * so no score can see them; the required Fleet jobs run them against the real daemon.
 */
export function oracleTests(root, entries, affectedPackages) {
  const affected = new Set(affectedPackages)
  const paths = entries.map((entry) => entry.path)
  const kind = new Map(entries.map((entry) => [entry.path, entry.kind]))
  const { graph } = dependencyGraph(root, paths)
  const tests = paths.filter((path) => kind.get(path) === 'test')
  const testReach = reachable(graph, tests)
  const productionReach = reachable(
    graph,
    paths.filter((path) => kind.get(path) === 'source' && (!testReach.has(path) || NEXT_ENTRY.test(path))),
  )
  const loadsUpdated = new Map()
  const oracleSide = (path) => kind.get(path) !== 'source' || !productionReach.has(path)
  const loads = (path) => {
    if (!loadsUpdated.has(path)) {
      const refs = references(readFileSync(resolve(root, path), 'utf8'), path)
      const unknown = refs.templates.some((template) => template === null)
      if (!unknown) graph.set(path, new Set([...graph.get(path), ...templateFiles(path, refs.templates)]))
      loadsUpdated.set(
        path,
        unknown || refs.imports.some((specifier) => affected.has(packageName(specifier))),
      )
    }
    return loadsUpdated.get(path)
  }
  /** Inventory files a relative template can name; it can name no package. */
  const templateFiles = (importer, templates) =>
    templates.flatMap(({ prefix, suffix }) => {
      const start = relative(root, resolve(root, dirname(importer), prefix))
      return paths.filter(
        (path) => path.startsWith(prefix.endsWith('/') ? `${start}/` : start) && path.endsWith(suffix),
      )
    })
  const result = new Map()
  for (const test of tests.filter((path) => !liveFleet.has(path))) {
    // Visit the closure first so relative templates add the files they can load.
    let closure = reachable(graph, [test])
    for (let size = 0; size !== closure.size; ) {
      size = closure.size
      for (const path of closure) loads(path)
      closure = reachable(graph, [test])
    }
    if (![...closure].some((path) => oracleSide(path) && loads(path))) continue
    result.set(test, [...closure].filter((path) => kind.get(path) === 'source').sort())
  }
  return result
}
