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
  // Controllers import this dependency-free leaf before input snapshots or proposed tests run.
  /^packages\/contracts\/src\/durations\.ts$/,
  /^\.github\/workflows\//,
  /^\.github\/CODEOWNERS$/,
  /(?:^|\/)bunfig\.toml$/,
  /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.[cm]?js)$/,
  /(?:^|\/)\.?lefthook(?:[./-]|rc(?:\.|$)|$)/,
  /^scripts\/check-(?:subject|mentions)\.ts$/,
  /(?:^|\/)junit-platform\.properties$/,
  /(?:^|\/)(?:\.babelrc|\.nycrc)(?:\.json|\.[cm]?js)?$/,
  /(?:^|\/)babel\.config\.[cm]?[jt]s$/,
  /(?:^|\/)(?:(?:vitest|jest|stryker|nyc|c8|istanbul|coverage)\.(?:config|conf)|vitest\.workspace)\.(?:[cm]?[jt]s|json|toml|ya?ml)$/,
  /^tools\/quality\//,
  /(?:^|\/)node_modules(?:\/|$)/,
  /^bun\.lockb$/,
  /^apps\/reporter\/(?:.*\.gradle(?:\.kts)?|gradle\.properties|gradle\/.*|gradlew(?:\.bat)?)$/,
]
const TEST_DEPENDENCY =
  /(?:istanbul|babel|stryker|fast-check|fast-xml-parser|typescript|vitest|jest|c8|nyc|test-runner|lefthook)/i
const SOURCE = /\.(?:[cm]?[jt]sx?|java)$/
const TEST = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/
const JAVA_TEST = /^apps\/reporter\/src\/test\/.*\.java$/
const ASSUMPTIONS = new Set(['assumeTrue', 'assumeFalse', 'assumeNotNull', 'assumingThat', 'abort'])
const CONDITIONAL_MODIFIERS = new Set(['if', 'skipIf', 'runIf', 'todoIf', 'failingIf'])
const MODIFIERS = new Set(['only', 'skip', 'todo', 'failing', ...CONDITIONAL_MODIFIERS])
const DISABLED_RUNNERS = new Set(['xit', 'xtest', 'xdescribe'])
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
    // A named import or destructuring binding can extract a disabled runner without a dot.
    // Reserve these keys independently of the receiver; otherwise aliases evade the scan.
    const binding =
      ['{', ','].includes(code[i - 1]?.value) && [':', ',', '}', 'as', '='].includes(code[i + 1]?.value)
    if (DISABLED_RUNNERS.has(token.value) && (token.type === 'code' || property || binding)) {
      findings.push(`test modifier: disabled runner ${token.value}`)
    }
    if ((!property && !binding) || !MODIFIERS.has(token.value)) continue
    let end = i + (token.type === 'string' ? 2 : 1)
    if (CONDITIONAL_MODIFIERS.has(token.value) && code[end]?.value === '(') {
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

// The one skip a new test file may add: database tests skip only where no Postgres is given.
// CI always gives one, and its JUnit evidence refuses any skipped case, so this never skips there.
const DATABASE_SKIP = 'test modifier: describe . skipIf ( ! hasDatabase )'
const HARNESS = 'apps/control/src/testing/harness.ts'

/**
 * A new test file may carry exactly one `describe.skipIf(!hasDatabase)`, and only when it needs
 * the database: `hasDatabase` and `startHarness` are imported, unrenamed, from the control
 * plane's harness, `startHarness` is called, and nothing else in the file binds `hasDatabase`.
 */
export function databaseSkipAllowed(path, source) {
  if (!TEST.test(path) || !path.startsWith('apps/control/src/')) return false
  if (escapeHatches(source, true).filter((finding) => finding === DATABASE_SKIP).length !== 1) return false
  const code = tokens(source).filter((token) => token.type !== 'comment')
  const imported = new Set()
  for (let i = 0; i < code.length; i++) {
    if (code[i].value !== 'import' || code[i + 1]?.value !== '{') continue
    let end = i + 2
    while (end < code.length && code[end].value !== '}') end++
    const from = code[end + 1]?.value === 'from' ? code[end + 2] : undefined
    if (from?.type !== 'string' || !from.value.startsWith('.')) continue
    const target = new URL(from.value, `file:///${path}`).pathname.slice(1)
    if (target !== HARNESS) continue
    const names = code.slice(i + 2, end)
    for (let n = 0; n < names.length; n++) {
      const name = names[n].value
      if (
        ['hasDatabase', 'startHarness'].includes(name) &&
        names[n + 1]?.value !== 'as' &&
        names[n - 1]?.value !== 'as'
      )
        imported.add(name)
    }
  }
  const uses = (name) => code.filter((token) => token.type === 'code' && token.value === name).length
  const called = code.some((token, i) => token.value === 'startHarness' && code[i + 1]?.value === '(')
  return imported.has('hasDatabase') && imported.has('startHarness') && called && uses('hasDatabase') === 2
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
    selected[group] = Object.fromEntries(
      Object.entries(value[group] ?? {})
        // Every script is an entrypoint: Bun also executes pre/post hooks for ordinary CI
        // commands. A name-based test filter misses install hooks and prelint/postlint.
        .filter(([name]) => group === 'scripts' || TEST_DEPENDENCY.test(name))
        .sort(([a], [b]) => a.localeCompare(b)),
    )
  }
  for (const key of [
    'packageManager',
    'trustedDependencies',
    'overrides',
    'resolutions',
    'workspaces',
    'patchedDependencies',
    'bin',
    'config',
  ]) {
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
 * Freeze quality tools and explicitly trusted install dependencies, including every nested and
 * hoisted variant. Lefthook runs from prepare, so its binaries/configuration are trust inputs.
 * Shared dependencies are conservative; unrelated package updates remain possible.
 */
export function qualityLock(source) {
  const lock = parseLock(source)
  const packages = Object.entries(lock.packages)
  if (
    lock.trustedDependencies !== undefined &&
    (!Array.isArray(lock.trustedDependencies) ||
      lock.trustedDependencies.some((name) => typeof name !== 'string'))
  )
    throw new Error('invalid trusted install dependency names')
  const names = new Set(lock.trustedDependencies ?? [])
  const roots = {}
  for (const [workspace, value] of Object.entries(lock.workspaces)) {
    const selected = {}
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(value[group] ?? {})) {
        if (!TEST_DEPENDENCY.test(name) && !names.has(name)) continue
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
  // An unrelated package can expose a binary named lefthook (or node/git) and replace the
  // command reached through node_modules/.bin without changing the original tool record.
  const commands = new Set(['bun', 'bunx', 'node', 'nodejs', 'git', 'sh', 'bash', 'lefthook'])
  const bins = (entry) => {
    const value = entry[2]?.bin
    if (typeof value === 'string') return [entry[0].slice(0, entry[0].lastIndexOf('@')).split('/').at(-1)]
    return Object.keys(value ?? {})
  }
  for (const entry of selected.values()) for (const command of bins(entry)) commands.add(command)
  const executableProviders = Object.fromEntries(
    packages.filter(([, entry]) => bins(entry).some((command) => commands.has(command))),
  )
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
  return canonical({ metadata, roots, packages: Object.fromEntries(selected), executableProviders })
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
      if (before === null && finding === DATABASE_SKIP && databaseSkipAllowed(path, after)) continue
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
