// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A config edit normally expands mutation testing to the whole tree. The narrower exception is
 * proved from both manifests and resolved Bun lock graphs: quality-only tools may be installed,
 * while every preexisting application and other development dependency keeps identical bytes
 * and dependency resolution. Relocating a hoisted package is allowed only with that same proof.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseLock } from './policy.mjs'

const TOOLS = new Set([
  '@babel/parser',
  '@stryker-mutator/core',
  'fast-check',
  'fast-xml-parser',
  'istanbul-lib-instrument',
])
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const QUALITY_COMMAND =
  /^(?:node (?:--test )?scripts\/quality\/[\w.*-]+\.mjs|python3 scripts\/quality\/[\w.-]+\.py|bun run quality:install)$/
const QUALITY_INSTALL = 'bun install --cwd tools/quality --frozen-lockfile'
const CONTROLLER_ROUTING =
  '\n[test]\n# These controllers run once under Node through test:quality and the CI static job.\n' +
  'pathIgnorePatterns = ["scripts/quality/*.test.mjs"]\n'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}

export const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

function withoutQualityDependencies(manifest) {
  const result = structuredClone(manifest)
  if (result.devDependencies) {
    for (const name of TOOLS) delete result.devDependencies[name]
    if (!Object.keys(result.devDependencies).length) delete result.devDependencies
  }
  return result
}

function qualityDependenciesValid(before, after) {
  for (const name of TOOLS) {
    const previous = before.devDependencies?.[name]
    const next = after.devDependencies?.[name]
    if (previous !== undefined && next === undefined) return false
    if (next !== undefined && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(next)) return false
  }
  return true
}

function manifestIsQualityOnly(before, after) {
  if (!qualityDependenciesValid(before, after)) return false
  const previous = withoutQualityDependencies(before)
  const next = withoutQualityDependencies(after)
  const oldScripts = previous.scripts ?? {}
  const newScripts = next.scripts ?? {}
  for (const [name, command] of Object.entries(newScripts)) {
    if (!Object.hasOwn(oldScripts, name) && name === 'quality:install') {
      if (command !== QUALITY_INSTALL) return false
      delete newScripts[name]
      continue
    }
    if (Object.hasOwn(oldScripts, name) || !/^test:quality(?::[\w-]+)?$/.test(name)) continue
    if (typeof command !== 'string' || !command.split(' && ').every((part) => QUALITY_COMMAND.test(part)))
      return false
    if (command.includes('bun run quality:install') && after.scripts['quality:install'] !== QUALITY_INSTALL)
      return false
    delete newScripts[name]
  }
  if (oldScripts.gates !== newScripts.gates) {
    if (typeof oldScripts.gates !== 'string' || typeof newScripts.gates !== 'string') return false
    const retained = newScripts.gates.split(' && ').filter((command) => {
      const script = /^bun run (test:quality(?::[\w-]+)?)$/.exec(command)?.[1]
      return !script || !Object.hasOwn(after.scripts ?? {}, script)
    })
    if (retained.join(' && ') !== oldScripts.gates) return false
    newScripts.gates = oldScripts.gates
  }
  return equal(previous, next)
}

/** Bun keys encode nested packages as name/name, with a scope belonging to its next segment. */
export function packageChain(key) {
  const parts = key.split('/')
  const chain = []
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index].startsWith('@') ? `${parts[index]}/${parts[++index]}` : parts[index]
    if (!name || name.endsWith('/undefined')) throw new Error('Ambiguous package key')
    chain.push(name)
  }
  return chain
}

export function dependencyKey(lock, parent, name) {
  const chain = parent ? packageChain(parent) : []
  for (let length = chain.length; length >= 0; length--) {
    const key = [...chain.slice(0, length), name].join('/')
    if (Object.hasOwn(lock.packages, key)) return key
  }
  return undefined
}

export function packageDependencies(entry) {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new Error('Invalid package record')
  const result = []
  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(entry[2]?.[group] ?? {}))
      result.push({ name, optional: group !== 'dependencies' })
  }
  return result
}

function roots(lock, quality) {
  const result = []
  for (const [workspace, manifest] of Object.entries(lock.workspaces)) {
    for (const group of GROUPS) {
      for (const name of Object.keys(manifest[group] ?? {})) {
        if ((workspace === '' && group === 'devDependencies' && TOOLS.has(name)) !== quality) continue
        result.push({ name, optional: group === 'optionalDependencies' || group === 'peerDependencies' })
      }
    }
  }
  return result
}

function qualityReachable(lock) {
  const seen = new Set()
  const visit = (key) => {
    if (!key || seen.has(key)) return
    seen.add(key)
    for (const { name, optional } of packageDependencies(lock.packages[key])) {
      const child = dependencyKey(lock, key, name)
      if (!child && !optional) throw new Error(`Unresolved quality dependency ${name}`)
      visit(child)
    }
  }
  for (const { name, optional } of roots(lock, true)) {
    const key = dependencyKey(lock, '', name)
    if (!key && !optional) throw new Error(`Unresolved quality root ${name}`)
    visit(key)
  }
  return seen
}

/** Returns false for missing/ambiguous data; never turns an unproved config edit into a skip. */
export function configurationOnlyAffectsQuality(beforeManifest, afterManifest, beforeLock, afterLock) {
  try {
    if (!manifestIsQualityOnly(beforeManifest, afterManifest)) return false
    const metadata = (lock) =>
      Object.fromEntries(Object.entries(lock).filter(([key]) => !['packages', 'workspaces'].includes(key)))
    if (!equal(metadata(beforeLock), metadata(afterLock))) return false
    const workspacePolicy = (lock) =>
      Object.fromEntries(
        Object.entries(lock.workspaces).map(([name, manifest]) => [
          name,
          name === '' ? withoutQualityDependencies(manifest) : manifest,
        ]),
      )
    if (!equal(workspacePolicy(beforeLock), workspacePolicy(afterLock))) return false
    if (!qualityDependenciesValid(beforeLock.workspaces[''], afterLock.workspaces[''])) return false
    for (const [manifest, lock] of [
      [beforeManifest, beforeLock],
      [afterManifest, afterLock],
    ]) {
      for (const group of GROUPS)
        if (!equal(manifest[group] ?? {}, lock.workspaces['']?.[group] ?? {})) return false
    }
    const previous = new Set()
    const next = new Set()
    const visited = new Set()
    const compare = (oldKey, newKey) => {
      if (!oldKey || !newKey) return oldKey === newKey
      const pair = `${oldKey}\0${newKey}`
      if (visited.has(pair)) return true
      visited.add(pair)
      if (!equal(beforeLock.packages[oldKey], afterLock.packages[newKey])) return false
      previous.add(oldKey)
      next.add(newKey)
      for (const { name, optional } of packageDependencies(beforeLock.packages[oldKey])) {
        const oldChild = dependencyKey(beforeLock, oldKey, name)
        const newChild = dependencyKey(afterLock, newKey, name)
        if ((!oldChild || !newChild) && !optional) return false
        if (!compare(oldChild, newChild)) return false
      }
      return true
    }
    for (const { name, optional } of roots(beforeLock, false)) {
      const oldKey = dependencyKey(beforeLock, '', name)
      const newKey = dependencyKey(afterLock, '', name)
      if ((!oldKey || !newKey) && !optional) return false
      if (!compare(oldKey, newKey)) return false
    }
    const oldQuality = qualityReachable(beforeLock)
    const newQuality = qualityReachable(afterLock)
    for (const key of new Set([...Object.keys(beforeLock.packages), ...Object.keys(afterLock.packages)])) {
      if (equal(beforeLock.packages[key], afterLock.packages[key])) continue
      if (beforeLock.packages[key] && !previous.has(key) && !oldQuality.has(key)) return false
      if (afterLock.packages[key] && !next.has(key) && !newQuality.has(key)) return false
    }
    return true
  } catch {
    return false
  }
}

/** Only the exact Node-controller discovery rule may be appended; all old Bun bytes must remain. */
export function configurationOnlyRoutesNodeControllers(before, after, manifest) {
  if (typeof before !== 'string' || typeof after !== 'string' || !before.endsWith('\n')) return false
  if (/(?:^|\n)\s*\[\s*(?:test\b|["']test["'])/.test(before)) return false
  if (after !== before + CONTROLLER_ROUTING) return false
  const scripts = manifest?.scripts ?? {}
  if (typeof scripts['test:quality'] !== 'string' || typeof scripts.gates !== 'string') return false
  const quality = scripts['test:quality'].split(' && ')
  const gates = scripts.gates.split(' && ')
  return (
    quality.filter((command) => command === 'node --test scripts/quality/*.test.mjs').length === 1 &&
    quality.every((command) => QUALITY_COMMAND.test(command)) &&
    gates.filter((command) => command === 'bun run test:quality').length === 1 &&
    gates.at(-1) === 'bun test' &&
    scripts.test === 'bun test'
  )
}

/** A structure ratchet can tighten or remove an existing allowance, never add or enlarge one. */
export function structureBaselineOnlyShrinks(before, after) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
  if (!object(before) || !object(after)) return false
  for (const [rule, entries] of Object.entries(after)) {
    if (!object(entries) || !object(before[rule])) return false
    for (const [path, entry] of Object.entries(entries)) {
      const previous = before[rule][path]
      if (
        !object(entry) ||
        !object(previous) ||
        !Number.isFinite(entry.n) ||
        entry.n < 0 ||
        !Number.isFinite(previous.n) ||
        entry.n > previous.n ||
        !equal({ ...entry, n: previous.n }, previous)
      )
        return false
    }
  }
  return true
}

export function qualityOnlyChanges(root, baseSha, changedFiles) {
  const result = new Set()
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? '') || !Array.isArray(changedFiles)) return result
  const before = (path) =>
    execFileSync('git', ['show', `${baseSha}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
  const after = (path) => {
    const full = resolve(root, path)
    if (!lstatSync(full).isFile()) throw new Error('Configuration is not a regular file')
    return readFileSync(full, 'utf8')
  }
  const baseline = 'scripts/structure-baseline.json'
  if (changedFiles.includes(baseline)) {
    try {
      if (structureBaselineOnlyShrinks(JSON.parse(before(baseline)), JSON.parse(after(baseline))))
        result.add(baseline)
    } catch {
      /* Missing or invalid baseline evidence receives no exception. */
    }
  }
  const config = changedFiles.filter((path) => ['package.json', 'bun.lock', 'bunfig.toml'].includes(path))
  if (!config.length) return result
  try {
    const beforeManifest = JSON.parse(before('package.json'))
    const afterManifest = JSON.parse(after('package.json'))
    if (
      configurationOnlyAffectsQuality(
        beforeManifest,
        afterManifest,
        parseLock(before('bun.lock')),
        parseLock(after('bun.lock')),
      )
    ) {
      for (const path of config.filter((path) => path !== 'bunfig.toml')) result.add(path)
    }
    if (
      config.includes('bunfig.toml') &&
      configurationOnlyRoutesNodeControllers(before('bunfig.toml'), after('bunfig.toml'), afterManifest)
    )
      result.add('bunfig.toml')
  } catch {
    /* Missing evidence expands mutation scope instead of waiving it. */
  }
  return result
}
