// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Proves which tests are additions, while retaining the base dependencies of edited tests.
 * Proposed code is parsed as data, never imported. Eligibility does not waive source/config
 * changes: callers keep their normal obligations and run unchanged tests before added tests.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { qualityOnlyChanges } from './config-impact.mjs'
import { classifySource, fileHash, inventory, parseSource } from './inventory.mjs'
import { dependencyGraph } from './mutation-dependencies.mjs'

const MODULE = /^(?:apps|packages|scripts|tools)\/.*\.(?:[cm]?[jt]s|[jt]sx)$/
const CONFIG =
  /(?:^|\/)(?:package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.jsonc?|(?:jest|vitest|stryker|nyc|c8|istanbul)[^/]*\.(?:[cm]?[jt]s|json|toml|ya?ml))$/
const ORACLE_DATA = /^(?:apps|packages|scripts)\/.*\.(?:jsonc?|toml|ya?ml|sql|snap|csv|txt)$/
const FIXTURE_INPUT = /(?:^|\/)(?:fixtures?|__fixtures__|testdata|test-data|snapshots?|__snapshots__)\//
const REGULAR = new Set(['100644', '100755'])

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  })
}

function commit(root, value) {
  if (value !== 'HEAD' && !/^[a-f0-9]{40}$/.test(value ?? ''))
    throw new Error('Test impact requires a commit SHA or HEAD')
  const sha = git(root, ['rev-parse', '--verify', `${value}^{commit}`]).trim()
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Cannot resolve the test impact commit')
  return sha
}

function tree(root, sha) {
  return new Map(
    git(root, ['ls-tree', '-r', '-z', sha])
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const separator = record.indexOf('\t')
        const [mode, type, oid] = record.slice(0, separator).split(' ')
        const path = record.slice(separator + 1)
        if (
          separator < 0 ||
          type !== 'blob' ||
          !/^[a-f0-9]{40}$/.test(oid) ||
          path.startsWith('/') ||
          path.split('/').some((part) => !part || part === '..')
        )
          throw new Error(`Unsupported Git input for test impact: ${path}`)
        return [path, { path, mode, oid }]
      }),
  )
}

function readHead(root, entries) {
  const contents = new Map()
  const hashes = new Map()
  const checkedDirectories = new Set([root])
  for (const [path, entry] of entries) {
    const absolute = resolve(root, path)
    let directory = dirname(absolute)
    while (!checkedDirectories.has(directory)) {
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Head input traverses a non-directory or symlink: ${path}`)
      checkedDirectories.add(directory)
      directory = dirname(directory)
    }
    const info = lstatSync(absolute)
    if (!REGULAR.has(entry.mode) || !info.isFile())
      throw new Error(`Head input must be a committed regular file: ${path}`)
    const bytes = readFileSync(absolute)
    if (Boolean(info.mode & 0o111) !== (entry.mode === '100755'))
      throw new Error(`Head input is not the committed file type: ${path}`)
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (oid !== entry.oid) throw new Error(`Working tree differs from inspected head: ${path}`)
    hashes.set(path, fileHash(bytes))
    if (MODULE.test(path) || path.endsWith('package.json')) contents.set(path, bytes)
  }
  if (git(root, ['ls-files', '--others', '--exclude-standard', '-z']).length)
    throw new Error('Untracked inputs cannot receive committed test-addition evidence')
  return { contents, hashes }
}

function baseContents(root, base, head, current) {
  const contents = new Map()
  const missing = []
  for (const [path, entry] of base) {
    if (!REGULAR.has(entry.mode)) throw new Error(`Base input must be a regular file: ${path}`)
    if (!MODULE.test(path) && !path.endsWith('package.json')) {
      // Dependency resolution needs the existence of imported JSON/CSS/assets, not their bytes.
      // Read-only placeholders preserve the committed tree without evaluating non-code content.
      contents.set(path, Buffer.alloc(0))
      continue
    }
    if (head.get(path)?.oid === entry.oid) contents.set(path, current.get(path))
    else missing.push(entry)
  }
  if (!missing.length) return contents
  const bytes = git(root, ['cat-file', '--batch'], {
    encoding: null,
    input: Buffer.from(`${missing.map((entry) => entry.oid).join('\n')}\n`),
  })
  let offset = 0
  for (const entry of missing) {
    const end = bytes.indexOf(10, offset)
    const [oid, type, sizeText] = bytes.subarray(offset, end).toString().split(' ')
    const size = Number(sizeText)
    if (oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0)
      throw new Error(`Invalid base blob evidence: ${entry.path}`)
    offset = end + 1
    contents.set(entry.path, bytes.subarray(offset, offset + size))
    offset += size + 1
  }
  return contents
}

function baseEntries(base, contents) {
  return new Map(
    [...base.keys()]
      .filter((path) => MODULE.test(path))
      .map((path) => {
        const text = contents.get(path).toString('utf8')
        return [path, { path, kind: classifySource(text, path), sha256: fileHash(contents.get(path)) }]
      }),
  )
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

function potentialSupport(graph, entries, changed, contents) {
  const tests = [...entries.values()].filter((entry) => entry.kind === 'test').map((entry) => entry.path)
  const testReach = reachable(graph, tests)
  // A file reached by a non-test entry is production. Everything reached only through tests is
  // conservatively treated as possible test support, regardless of its directory or filename.
  const productionReach = reachable(
    graph,
    [...entries.values()]
      .filter((entry) => entry.kind === 'source' && !testReach.has(entry.path))
      .map((entry) => entry.path),
  )
  return new Set(
    changed.filter((path) => {
      if (entries.get(path)?.kind !== 'source') return false
      if (testReach.has(path) && !productionReach.has(path)) return true
      const ast = parseSource(contents.get(path).toString('utf8'), path)
      return ast.program.body.some(
        (node) =>
          node.type === 'ImportDeclaration' &&
          /^(?:bun:test|node:assert(?:\/strict)?|assert(?:\/strict)?|expect|chai|vitest|@jest\/globals)$/.test(
            node.source.value,
          ),
      )
    }),
  )
}

function retainImpactedDependencies(
  root,
  contents,
  entries,
  headContents,
  headEntries,
  changed,
  changedTests,
  required,
  reasons,
) {
  const changedModules = changed.filter(
    (path) => entries.get(path)?.kind === 'source' || headEntries.get(path)?.kind === 'source',
  )
  if (!changedTests.length && !changedModules.length)
    return { full: false, affectedTests: [], mappedBaseTests: new Set() }
  const snapshot = mkdtempSync(join(tmpdir(), 'quality-base-impact-'))
  let full = false
  const affected = new Set(changedTests)
  const mappedBaseTests = new Set()
  try {
    for (const [path, bytes] of contents) {
      const target = resolve(snapshot, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes, { mode: 0o444 })
    }
    const graphs = [
      { label: 'base', entries, contents, ...dependencyGraph(snapshot, [...entries.keys()]) },
      {
        label: 'head',
        entries: headEntries,
        contents: headContents,
        ...dependencyGraph(root, [...headEntries.keys()]),
      },
    ]
    for (const view of graphs) {
      const support = potentialSupport(view.graph, view.entries, changedModules, view.contents)
      for (const entry of view.entries.values()) {
        if (entry.kind !== 'test') continue
        const dependencies = reachable(view.graph, [entry.path])
        if ([...support].some((path) => dependencies.has(path))) {
          affected.add(entry.path)
          reasons.push(`changed potential test support affects ${view.label} test: ${entry.path}`)
        }
        if (changedModules.length && [...dependencies].some((path) => view.ambiguous.has(path))) {
          full = true
          reasons.push(`ambiguous ${view.label} test dependencies after executable changes: ${entry.path}`)
        }
      }
    }
    for (const view of graphs) {
      for (const test of affected) {
        const dependencies = reachable(view.graph, [test])
        if (
          view.label === 'base' &&
          view.entries.get(test)?.kind === 'test' &&
          [...dependencies].some((file) => view.entries.get(file)?.kind === 'source') &&
          ![...dependencies].some((file) => view.ambiguous.has(file))
        )
          mappedBaseTests.add(test)
        for (const file of dependencies) {
          if (view.entries.get(file)?.kind === 'source') required.add(file)
          if (view.ambiguous.has(file)) {
            full = true
            reasons.push(`ambiguous ${view.label} dependency mapping: ${test} through ${file}`)
          }
        }
      }
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
  }
  return { full, affectedTests: [...affected].sort(), mappedBaseTests }
}

/** All returned exemptions are derived here; callers cannot supply an eligibility assertion. */
export function analyzeTestImpact({ root, baseSha, changedFiles, headSha = 'HEAD' }) {
  root = resolve(root)
  const base = commit(root, baseSha)
  const head = commit(root, headSha)
  if (base === head) throw new Error('A test impact comparison cannot use the proposed head as its base')
  try {
    git(root, ['merge-base', '--is-ancestor', base, head])
  } catch {
    throw new Error('The test impact base must be an ancestor of the proposed head')
  }
  const previous = tree(root, base)
  const proposed = tree(root, head)
  const verifiedChangedFiles = [...new Set([...previous.keys(), ...proposed.keys()])]
    .filter(
      (path) =>
        previous.get(path)?.oid !== proposed.get(path)?.oid ||
        previous.get(path)?.mode !== proposed.get(path)?.mode,
    )
    .sort()
  if (
    !Array.isArray(changedFiles) ||
    changedFiles.some((path) => typeof path !== 'string') ||
    new Set(changedFiles).size !== changedFiles.length ||
    JSON.stringify([...changedFiles].sort()) !== JSON.stringify(verifiedChangedFiles)
  )
    throw new Error('Supplied changed files do not match the complete base-to-head Git diff')
  const current = readHead(root, proposed)
  const headEntries = new Map(inventory(root).map((entry) => [entry.path, entry]))
  const oldContents = baseContents(root, previous, proposed, current.contents)
  const oldEntries = baseEntries(previous, oldContents)
  const verifiedAddedTests = new Set()
  const baseRequiredSubjects = new Set()
  const removedProductionFiles = new Set()
  const reasons = []
  let baseFull = false
  const changedExistingTests = verifiedChangedFiles.filter((path) => oldEntries.get(path)?.kind === 'test')
  const removedTests = changedExistingTests.filter((path) => headEntries.get(path)?.kind !== 'test')
  if (removedTests.length) reasons.push(`existing tests removed or renamed: ${removedTests.join(', ')}`)
  for (const path of verifiedChangedFiles) {
    if (oldEntries.get(path)?.kind === 'source') {
      if (headEntries.get(path)?.kind === 'source') baseRequiredSubjects.add(path)
      else {
        removedProductionFiles.add(path)
        baseFull = true
        reasons.push(`production source removed or reclassified: ${path}`)
      }
    }
    if (previous.has(path) || headEntries.get(path)?.kind !== 'test' || removedTests.length) continue
    if (!REGULAR.has(proposed.get(path)?.mode)) throw new Error(`Added test must be a regular file: ${path}`)
    const text = current.contents.get(path).toString('utf8')
    const ast = parseSource(text, path)
    if (classifySource(text, path.replace(/\.(?:test|spec)(?=\.)/, ''), ast) !== 'source')
      throw new Error(`Added test contains no executable test code: ${path}`)
    verifiedAddedTests.add(path)
  }
  const impact = retainImpactedDependencies(
    root,
    oldContents,
    oldEntries,
    current.contents,
    headEntries,
    verifiedChangedFiles,
    changedExistingTests,
    baseRequiredSubjects,
    reasons,
  )
  baseFull = impact.full || baseFull
  const mappedRemovedTests = new Set(removedTests.filter((path) => impact.mappedBaseTests.has(path)))
  const unmappedRemovedTests = removedTests.filter((path) => !mappedRemovedTests.has(path))
  if (unmappedRemovedTests.length) {
    baseFull = true
    reasons.push(
      `removed tests have empty or ambiguous base dependencies: ${unmappedRemovedTests.join(', ')}`,
    )
  }
  const verifiedQualityOnlyConfigs = qualityOnlyChanges(root, base, verifiedChangedFiles)
  for (const path of verifiedChangedFiles) {
    if (CONFIG.test(path) && !path.startsWith('tools/quality/') && !verifiedQualityOnlyConfigs.has(path)) {
      baseFull = true
      reasons.push(`application dependency or test resolution configuration changed: ${path}`)
    }
    if (
      (ORACLE_DATA.test(path) || FIXTURE_INPUT.test(path)) &&
      !path.startsWith('scripts/quality/') &&
      !verifiedQualityOnlyConfigs.has(path)
    ) {
      baseFull = true
      reasons.push(`fixture or data input requires conservative mutation scope: ${path}`)
    }
  }
  const unchangedTestManifest = [...oldEntries.values()]
    .filter(
      (entry) =>
        entry.kind === 'test' &&
        headEntries.get(entry.path)?.sha256 === entry.sha256 &&
        previous.get(entry.path)?.mode === proposed.get(entry.path)?.mode,
    )
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const preservedInputs = [...proposed.values()]
    .filter(
      (entry) => previous.get(entry.path)?.oid === entry.oid && previous.get(entry.path)?.mode === entry.mode,
    )
    .map(({ path, mode }) => ({ path, mode, sha256: current.hashes.get(path) }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const evidence = {
    version: 1,
    base,
    head,
    verifiedChangedFiles,
    verifiedAddedTests: [...verifiedAddedTests].sort(),
    requiredChangedFiles: verifiedChangedFiles.filter((path) => !verifiedAddedTests.has(path)),
    baseRequiredSubjects: [...baseRequiredSubjects].sort(),
    removedProductionFiles: [...removedProductionFiles].sort(),
    mappedRemovedTests: [...mappedRemovedTests].sort(),
    baseFull,
    reasons,
    verifiedQualityOnlyConfigs: [...verifiedQualityOnlyConfigs].sort(),
    affectedExistingTests: impact.affectedTests,
    unchangedTestManifest,
    preservedInputs,
    preservedInputsHash: fileHash(JSON.stringify(preservedInputs)),
  }
  return {
    ...evidence,
    verifiedAddedTests,
    baseRequiredSubjects,
    removedProductionFiles,
    mappedRemovedTests,
    headSourceFiles: [...headEntries.values()]
      .filter((entry) => entry.kind === 'source')
      .map((entry) => entry.path)
      .sort(),
    headTestFiles: [...headEntries.values()]
      .filter((entry) => entry.kind === 'test')
      .map((entry) => entry.path)
      .sort(),
    evidence,
  }
}
