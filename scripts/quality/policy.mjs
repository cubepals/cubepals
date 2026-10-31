// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Compares Git objects without checking out or executing the proposed tree. The policy workflow
 * runs this file from its protected base commit. Policy changes have no label, environment
 * variable, or head-controlled opt-out: installing a new policy is an administrator operation.
 *
 * node scripts/quality/policy.mjs --base <commit> --head <commit>
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PROTECTED = [
  /^scripts\/quality(?:\/|\.)/,
  /^\.github\/workflows\//,
  /^\.github\/CODEOWNERS$/,
  /(?:^|\/)bunfig\.toml$/,
  /(?:^|\/)junit-platform\.properties$/,
  /(?:^|\/)(?:\.babelrc|\.nycrc)(?:\.json|\.[cm]?js)?$/,
  /(?:^|\/)babel\.config\.[cm]?[jt]s$/,
  /(?:^|\/)(?:vitest|jest|stryker|nyc|c8|istanbul|coverage)[^/]*\.(?:[cm]?[jt]s|json|toml|ya?ml)$/,
  /^tools\/quality\//,
  /^bun\.lockb$/,
  /^apps\/reporter\/(?:.*\.gradle(?:\.kts)?|gradle\.properties|gradle\/.*|gradlew(?:\.bat)?)$/,
]
const TEST_COMMAND = /(?:test|quality|coverage|mutation|gates)/i
const TEST_DEPENDENCY =
  /(?:istanbul|babel|stryker|fast-check|fast-xml-parser|typescript|vitest|jest|c8|nyc|test-runner)/i
const SOURCE = /\.(?:[cm]?[jt]sx?|java)$/
const TEST = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/
const JAVA_TEST = /^apps\/reporter\/src\/test\/.*\.java$/
const ASSUMPTIONS = new Set(['assumeTrue', 'assumeFalse', 'assumeNotNull', 'assumingThat', 'abort'])
const MODIFIERS = new Set(['only', 'skip', 'todo', 'skipIf', 'runIf', 'failing'])
const EVIDENCE_APIS = new Set([
  '__qualityCoverage__',
  '__coverage__',
  '__stryker__',
  '__STRYKER_ACTIVE_MUTANT__',
  'STRYKER_ACTIVE_MUTANT',
  'QUALITY_REPORT',
  'QUALITY_ROOT',
  'QUALITY_SHARD',
  'QUALITY_PREPARED',
  'QUALITY_PREPARED_SHA256',
  'QUALITY_PARTS',
  'QUALITY_PHASE',
  'QUALITY_EXPECTED_BASE',
  'QUALITY_EXPECTED_HEAD',
])
const IGNORE =
  /\b(?:istanbul|c8|v8|bun|stryker)\s*[-:]?\s*(?:ignore|disable)\b|\b(?:coverage|mutation)\s*[-:]?\s*(?:ignore|disable)\b/i

/** Tokenization keeps comments and strings separate, so fixture strings are not directives. */
function tokens(source) {
  const result = []
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\?\.|[^\s]/g
  for (const match of source.matchAll(pattern)) {
    const raw = match[0]
    const type =
      raw.startsWith('//') || raw.startsWith('/*') ? 'comment' : /^["'`]/.test(raw) ? 'string' : 'code'
    result.push({ type, raw, value: type === 'string' ? raw.slice(1, -1) : raw })
  }
  return result
}

/** Existing conditional skips may remain; a new or changed condition requires a policy update. */
export function escapeHatches(source, isTest, javaTest = false) {
  const all = tokens(source)
  const findings = all
    .filter((token) => token.type === 'comment' && IGNORE.test(token.raw))
    .map((token) => `ignore: ${token.raw.replace(/\s+/g, ' ')}`)
  for (const token of all) {
    if (token.type !== 'comment' && EVIDENCE_APIS.has(token.value))
      findings.push(`evidence access: ${token.value}`)
  }
  if (!isTest) return findings
  const code = all.filter((token) => token.type !== 'comment')
  for (let i = 0; i < code.length; i++) {
    const token = code[i]
    if (javaTest && token.type === 'code') {
      if (/^(?:Disabled\w*|Enabled\w*|Ignore)$/.test(token.value)) {
        let start = i
        while (code[start - 1]?.value === '.' && code[start - 2]?.type === 'code') start -= 2
        if (code[start - 1]?.value === '@') findings.push(`disabled Java test: ${token.value}`)
      }
      if (ASSUMPTIONS.has(token.value) && code[i + 1]?.value === '(')
        findings.push(`conditional Java test: ${token.value}`)
    }
    const property =
      (token.type === 'code' && ['.', '?.'].includes(code[i - 1]?.value)) ||
      (token.type === 'string' && code[i - 1]?.value === '[' && code[i + 1]?.value === ']')
    if (!property || !MODIFIERS.has(token.value)) continue
    let end = i + (token.type === 'string' ? 2 : 1)
    if (['skipIf', 'runIf'].includes(token.value) && code[end]?.value === '(') {
      let depth = 0
      do {
        if (code[end].value === '(') depth++
        if (code[end].value === ')') depth--
        end++
      } while (end < code.length && depth > 0)
    }
    findings.push(
      `test modifier: ${code
        .slice(Math.max(0, i - 2), end)
        .map((part) => part.raw)
        .join(' ')}`,
    )
  }
  return findings
}

function addedOccurrences(before, after) {
  const remaining = new Map()
  for (const value of before) remaining.set(value, (remaining.get(value) ?? 0) + 1)
  return after.filter((value) => {
    const count = remaining.get(value) ?? 0
    if (count > 0) {
      remaining.set(value, count - 1)
      return false
    }
    return true
  })
}

function packagePolicy(source) {
  if (source === null) return null
  const value = JSON.parse(source)
  const selected = {}
  for (const group of [
    'scripts',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const pattern = group === 'scripts' ? TEST_COMMAND : TEST_DEPENDENCY
    selected[group] = Object.fromEntries(
      Object.entries(value[group] ?? {})
        .filter(
          ([name, command]) => pattern.test(name) || (group === 'scripts' && TEST_COMMAND.test(command)),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    )
  }
  for (const key of ['packageManager', 'trustedDependencies', 'overrides', 'resolutions', 'workspaces']) {
    selected[key] = value[key] ?? null
  }
  return selected
}

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

/** Parse Bun's JSON with trailing commas as data, never eval or an installed head dependency. */
export function parseLock(source) {
  if (source === null) throw new Error('the quality lockfile must exist in both trees')
  const parts = tokens(source).filter((token) => token.type !== 'comment')
  const text = parts
    .filter((token, index) => token.raw !== ',' || !['}', ']'].includes(parts[index + 1]?.raw))
    .map((token) => token.raw)
    .join('')
  const lock = JSON.parse(text)
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.workspaces)
    throw new Error('unsupported Bun lockfile format')
  return lock
}

/**
 * Freeze the complete quality tool graph, including hashes and every nested/hoisted variant of
 * its dependencies. This is conservative when applications share dependencies with test tools,
 * but unrelated package updates remain possible. Added shadow versions also change this graph.
 */
export function qualityLock(source) {
  const lock = parseLock(source)
  const packages = Object.entries(lock.packages)
  const names = new Set()
  const roots = {}
  for (const [workspace, value] of Object.entries(lock.workspaces)) {
    const selected = {}
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(value[group] ?? {})) {
        if (!TEST_DEPENDENCY.test(name)) continue
        names.add(name)
        selected[`${group}:${name}`] = version
      }
    }
    if (Object.keys(selected).length) roots[workspace] = selected
  }
  const selected = new Map()
  for (const name of names) {
    for (const [key, entry] of packages) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string')
        throw new Error(`invalid package record: ${key}`)
      const resolvedName = entry[0].slice(0, entry[0].lastIndexOf('@'))
      if (key !== name && !key.endsWith(`/${name}`) && resolvedName !== name) continue
      if (selected.has(key)) continue
      selected.set(key, entry)
      for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'])
        for (const dependency of Object.keys(entry[2]?.[group] ?? {})) names.add(dependency)
    }
  }
  for (const name of names) {
    if (
      !packages.some(
        ([key, entry]) =>
          key === name || key.endsWith(`/${name}`) || entry[0].slice(0, entry[0].lastIndexOf('@')) === name,
      )
    ) {
      // Optional peers may be absent. Their names remain in the signature so later additions
      // cannot silently change the tools' runtime resolution.
      selected.set(`absent:${name}`, null)
    }
  }
  const metadata = Object.fromEntries(
    Object.entries(lock).filter(([key]) => !['packages', 'workspaces'].includes(key)),
  )
  return canonical({ metadata, roots, packages: Object.fromEntries(selected) })
}

/** Pure comparison also used by the adversarial tests, with blobs supplied from real commits. */
export function inspectChanges(changes) {
  const errors = []
  for (const { path, before, after, modeBefore, modeAfter } of changes) {
    if (before === after && modeBefore === modeAfter) continue
    if (PROTECTED.some((pattern) => pattern.test(path))) {
      errors.push(`${path}: protected quality infrastructure changed; administrator policy update required`)
      continue
    }
    if (path === 'bun.lock') {
      try {
        if (JSON.stringify(qualityLock(before)) !== JSON.stringify(qualityLock(after)))
          errors.push(
            `${path}: protected quality tool lock graph changed; administrator policy update required`,
          )
      } catch (error) {
        errors.push(`${path}: protected quality tool lock cannot be verified: ${error.message}`)
      }
      continue
    }
    if (/(?:^|\/)package\.json$/.test(path)) {
      try {
        if (JSON.stringify(packagePolicy(before)) !== JSON.stringify(packagePolicy(after))) {
          errors.push(`${path}: protected test command, tool version, install policy, or workspace changed`)
        }
      } catch {
        errors.push(`${path}: package manifest is not valid JSON`)
      }
    }
    if (!SOURCE.test(path) || after === null) continue
    if (modeAfter !== undefined && modeAfter !== '100644' && modeAfter !== '100755') {
      errors.push(`${path}: executable source must be a regular file`)
      continue
    }
    for (const finding of addedOccurrences(
      escapeHatches(before ?? '', TEST.test(path) || JAVA_TEST.test(path), JAVA_TEST.test(path)),
      escapeHatches(after, TEST.test(path) || JAVA_TEST.test(path), JAVA_TEST.test(path)),
    )) {
      errors.push(`${path}: added ${finding}`)
    }
  }
  return errors
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function tree(ref, cwd) {
  const entries = new Map()
  for (const record of git(['ls-tree', '-r', '-z', ref], cwd).split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [mode, type, object] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), { mode, type, object })
  }
  return entries
}

/** Hash-only refs prevent option/ref injection; reading blobs does not resolve tree symlinks. */
export function checkCommits(base, head, cwd = process.cwd()) {
  for (const [name, ref] of [
    ['base', base],
    ['head', head],
  ]) {
    if (!/^[a-f0-9]{40,64}$/.test(ref ?? '')) throw new Error(`${name} must be a full commit hash`)
    git(['cat-file', '-e', `${ref}^{commit}`], cwd)
  }
  const before = tree(base, cwd)
  const after = tree(head, cwd)
  const changes = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path)
    const next = after.get(path)
    if (old?.object === next?.object && old?.mode === next?.mode) continue
    if (PROTECTED.some((pattern) => pattern.test(path))) {
      changes.push({
        path,
        before: old?.object ?? null,
        after: next?.object ?? null,
        modeBefore: old?.mode,
        modeAfter: next?.mode,
      })
      continue
    }
    if (!SOURCE.test(path) && !/(?:^|\/)package\.json$/.test(path) && path !== 'bun.lock') continue
    const blob = (entry) =>
      entry ? (entry.type === 'blob' ? git(['cat-file', 'blob', entry.object], cwd) : '') : null
    changes.push({ path, before: blob(old), after: blob(next), modeBefore: old?.mode, modeAfter: next?.mode })
  }
  return inspectChanges(changes)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 4 || args[0] !== '--base' || args[2] !== '--head') {
      throw new Error('usage: policy.mjs --base <commit> --head <commit>')
    }
    const errors = checkCommits(args[1], args[3])
    if (errors.length) throw new Error(errors.join('\n'))
    process.stdout.write('Quality policy: proposed tree preserves the trusted gate and test controls.\n')
  } catch (error) {
    console.error(`Quality policy rejected: ${error.message}`)
    process.exitCode = 1
  }
}
