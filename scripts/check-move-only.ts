// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Proves a `Move:` pull request only moves code. Run: bun run check:move-only [--base <ref>]
// [--head <ref>] [--allow <file>]
//
// Splitting a file is its own change, in which code moves and nothing else does. This reads the
// diff of source files (.rs, .ts, .tsx and .py under apps/, packages/ and scripts/) from the merge
// base of --base (default origin/main) to --head (default HEAD), and holds every removed line to
// being added back somewhere, and every added line to being a moved line or text a move may add:
// module boilerplate (mod, use, import, export … from, impl … {, lines of closing brackets), a
// file's leading header comment, the `pub(super) ` or `export ` a moved line needs for its siblings
// to see it, and the lines the PR declares under `## Not a move` (from PR_BODY, or a file given to
// --allow). A section banner may go. Whatever is left is compared once more as tokens, without
// whitespace or trailing commas, so a formatter re-wrapping a moved line passes. Lockfiles,
// generated code, migrations and fixtures are skipped; any other file outside source fails, since a
// move edits no configuration, docs or workflows. The one exception is the structure ratchet's
// baseline (scripts/structure-baseline.json): a split file's entries go stale, and a move may drop
// entries or lower their numbers, never add one, raise one or change a reason.
//
// It shows only that lines moved: not that the place they moved to is right, nor that they mean
// the same there. Lines are compared across the whole change as a multiset, so a line reordered
// inside a moved function, or swapped between two of them, passes. So does an edit the token
// comparison can't see: one that only reorders tokens among lines that differ anyway (two
// arguments swapped), or adds or drops a comma before a closing bracket.
import { readFileSync } from 'node:fs'

type Lang = 'rust' | 'ts' | 'py'
type Rule = 'boilerplate' | 'header' | 'banner'
type Line = { path: string; line: number; text: string; lang: Lang; rule: Rule | null }

const SOURCE: Record<string, Lang> = { rs: 'rust', ts: 'ts', tsx: 'ts', py: 'py' }
const ROOTS = /^(apps|packages|scripts)\//
const SKIPPED =
  /(^|\/)(bun\.lockb?|Cargo\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock)$|(^|\/)(generated|migrations|fixtures|__fixtures__)\//
const MAX_DECLARED = 40
/** The structure ratchet's baseline, which a move may only shrink. */
const BASELINE = 'scripts/structure-baseline.json'
/** What a moved line may gain so its siblings can reach it. Nothing else about visibility. */
const VISIBILITY: Record<Lang, RegExp | null> = {
  rust: /^pub\(super\) /,
  ts: /^export (?!default\b)/,
  py: null,
}
/** A comment line that only divides a file: a label and a rule of ─, ═, - or =. */
const BANNER = /^(\/\/[/!]?|#|\/\*+|\*)\s*([─═=-]{3,}.*|.*[─═=-]{3,}(\s*\*\/)?)$/
/** A line of closing brackets: an array split in pieces removes one `]` and adds one per piece. */
const CLOSING = /^([}\])] ?)+[;,]?$/
/** Literals stay whole, so whitespace inside a string still counts; Rust's `'` also starts a lifetime. */
const TOKEN: Record<Lang, RegExp> = {
  rust: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|\w+|\S/g,
  ts: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\w+|\S/g,
  py: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\w+|\S/g,
}

const normal = (text: string) => text.trim().replace(/\s+/g, ' ')
const where = (line: Line) => `${line.path}:${line.line}: ${line.text}`

const args = process.argv.slice(2)
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

function git(...argv: string[]): string {
  const run = Bun.spawnSync(['git', '-c', 'core.quotepath=off', ...argv], { cwd: root, stderr: 'pipe' })
  if (run.exitCode !== 0) {
    console.error(`git ${argv.join(' ')} failed: ${run.stderr.toString().trim()}`)
    process.exit(1)
  }
  return run.stdout.toString()
}

/** Which rule lets each line of a file appear or disappear without a match, if any. */
function rulesOf(lang: Lang, source: string): Array<Rule | null> {
  const lines = source.split('\n').map(normal)
  const rules: Array<Rule | null> = lines.map((line) =>
    CLOSING.test(line) ? 'boilerplate' : BANNER.test(line) ? 'banner' : null,
  )
  /** Marks lines from `start` to the first that matches `end` as boilerplate; none if no line does. */
  const statement = (start: number, end: RegExp, stop = /$^/) => {
    for (let i = start; i < lines.length; i++) {
      // The line that ends a statement may also hold `stop`, as `} from '…'` holds its `}`.
      if (end.test(lines[i] ?? '')) {
        rules.fill('boilerplate', start, i + 1)
        return
      }
      if (stop.test(lines[i] ?? '')) return
    }
  }

  // The header: the leading run of `//!` in Rust; in TypeScript the first `/** … */` before any
  // code, after a `'use client'` if there is one.
  let top = lines.findIndex((line) => line !== '')
  if (lang === 'rust') while (top !== -1 && lines[top]?.startsWith('//!')) rules[top++] = 'header'
  if (lang === 'ts' && top !== -1) {
    if (/^['"]use (client|server)['"];?$/.test(lines[top] ?? ''))
      top = lines.findIndex((line, i) => i > top && line !== '')
    const end = lines.findIndex((line, i) => i >= top && line.includes('*/'))
    if (top !== -1 && lines[top]?.startsWith('/**') && end !== -1) rules.fill('header', top, end + 1)
  }

  lines.forEach((line, i) => {
    if (lang === 'rust') {
      if (/^(pub(\([^)]*\))? )?use /.test(line)) statement(i, /;$/)
      if (/^(pub(\([^)]*\))? )?mod \w+;$|^(unsafe )?impl\b.*\{$|^#\[cfg\(test\)\]$|^mod tests \{$/.test(line))
        rules[i] = 'boilerplate'
    }
    if (lang === 'ts') {
      if (/^import[\s{'"*]/.test(line)) statement(i, /['"];?$/)
      if (/^export (type )?(\*|\{)/.test(line)) statement(i, /\bfrom ?['"][^'"]+['"];?$/, /}/)
    }
    if (lang === 'py') {
      if (/^import \S/.test(line)) rules[i] = 'boilerplate'
      if (/^from \S+ import /.test(line)) statement(i, line.endsWith('(') ? /\)$/ : /$/)
    }
  })
  return rules
}

const root = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel']).stdout.toString().trim() || '.'
const head = option('--head') ?? 'HEAD'
const base = git('merge-base', option('--base') ?? 'origin/main', head).trim()

// Declared exceptions: the first fenced block under `## Not a move`, or every line of --allow's file.
const allowFile = option('--allow')
const declaring = (allowFile === undefined ? (process.env.PR_BODY ?? '') : readFileSync(allowFile, 'utf8'))
  .replace(/\r/g, '')
  .split('\n')
const heading = declaring.findIndex((line) => /^##\s+Not a move\s*$/i.test(line.trim()))
const open = declaring.findIndex((line, i) => heading !== -1 && i > heading && /^(```|~~~)/.test(line.trim()))
const close = declaring.findIndex(
  (line, i) => open !== -1 && i > open && line.trim().startsWith(declaring[open]?.trim().slice(0, 3) ?? ''),
)
const declaredText = (
  heading !== -1
    ? open === -1
      ? []
      : declaring.slice(open + 1, close === -1 ? undefined : close)
    : allowFile !== undefined
      ? declaring
      : []
)
  .map(normal)
  .filter((line) => line !== '')

/** Most checks hold numbered entries by key; `headers` holds a list of files under one reason. */
type Baseline = Record<
  string,
  Record<string, { n?: number; reason?: string }> & { files?: string[]; reason?: string }
>

type Check = Baseline[string]

/** A list of files under one reason (`headers`): it may only lose files. */
function listGrew(check: string, before: Check, after: Check): string | null {
  if (after.reason !== before.reason) return `changes the reason for ${check}`
  const added = (after.files ?? []).find((file) => !(before.files ?? []).includes(file))
  return added === undefined ? null : `adds ${check} ${added}`
}

/** Numbered entries by key: each may go or come down, never appear, go up or change its reason. */
function entriesGrew(check: string, before: Check, after: Check): string | null {
  for (const [key, entry] of Object.entries(after)) {
    const was = before[key]
    if (was === undefined) return `adds ${check} ${key}`
    if ((entry.n ?? 0) > (was.n ?? 0)) return `raises ${check} ${key}`
    if (entry.reason !== was.reason) return `changes the reason for ${check} ${key}`
  }
  return null
}

/** Why the baseline at `head` isn't only the one at `base` shrunk, or null when it is. */
function grew(before: Baseline, after: Baseline): string | null {
  for (const [check, entries] of Object.entries(after)) {
    const was = before[check]
    const growth =
      was === undefined
        ? `adds ${check}`
        : Array.isArray(entries.files)
          ? listGrew(check, was, entries)
          : entriesGrew(check, was, entries)
    if (growth !== null) return growth
  }
  return null
}

const skipped: string[] = []
const shrunk: string[] = []
const outside: string[] = []
const added: Line[] = []
const removed: Line[] = []
const status = git('diff', '--no-renames', '--name-status', '-z', base, head).split('\0')
for (let i = 0; i + 1 < status.length; i += 2) {
  const [change, path] = [status[i] ?? '', status[i + 1] ?? '']
  const lang = SOURCE[path.split('.').pop() ?? '']
  if (SKIPPED.test(path)) skipped.push(path)
  else if (path === BASELINE && change === 'M') {
    const growth = grew(
      JSON.parse(git('show', `${base}:${path}`)),
      JSON.parse(git('show', `${head}:${path}`)),
    )
    if (growth === null) shrunk.push(path)
    else outside.push(`${path}: ${growth}`)
  } else if (!ROOTS.test(path) || lang === undefined) outside.push(path)
  else {
    const before = change === 'A' ? [] : rulesOf(lang, git('show', `${base}:${path}`))
    const after = change === 'D' ? [] : rulesOf(lang, git('show', `${head}:${path}`))
    let [oldLine, newLine, inHunk] = [0, 0, false]
    for (const row of git(
      'diff',
      '--no-renames',
      '--no-ext-diff',
      '--no-color',
      '-U0',
      base,
      head,
      '--',
      path,
    )
      .replace(/\r/g, '')
      .split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
      if (hunk) [oldLine, newLine, inHunk] = [Number(hunk[1]), Number(hunk[2]), true]
      else if (inHunk && row.startsWith('-')) {
        const text = normal(row.slice(1))
        if (text !== '') removed.push({ path, line: oldLine, text, lang, rule: before[oldLine - 1] ?? null })
        oldLine++
      } else if (inHunk && row.startsWith('+')) {
        const text = normal(row.slice(1))
        // A banner may only go: one added is a comment like any other.
        const rule = after[newLine - 1] === 'banner' ? null : (after[newLine - 1] ?? null)
        if (text !== '') added.push({ path, line: newLine, text, lang, rule })
        newLine++
      }
    }
  }
}

// Moved: each added line takes a removed line with the same text. Lines no rule allows claim one
// first, so an allowed line never takes the match a line that needs it would have had.
const ruled = (a: Line, b: Line) => Number(a.rule !== null) - Number(b.rule !== null)
const unmatched = new Map<string, Line[]>()
for (const line of [...removed].sort(ruled))
  unmatched.set(line.text, [...(unmatched.get(line.text) ?? []), line])
let moved = 0
let leftAdded: Line[] = []
for (const line of [...added].sort(ruled)) {
  if (unmatched.get(line.text)?.shift()) moved++
  else leftAdded.push(line)
}
// Made visible: the same line with a `pub(super) ` or `export ` in front.
const visible: Line[] = []
leftAdded = leftAdded.filter((line) => {
  const prefix = VISIBILITY[line.lang]?.exec(line.text)?.[0]
  if (prefix === undefined || !unmatched.get(line.text.slice(prefix.length))?.shift()) return true
  visible.push(line)
  return false
})
let leftRemoved = [...unmatched.values()].flat()

const allowed: Record<Rule, Line[]> = { boilerplate: [], header: [], banner: [] }
for (const line of [...leftAdded, ...leftRemoved]) if (line.rule !== null) allowed[line.rule].push(line)
leftAdded = leftAdded.filter((line) => line.rule === null)
leftRemoved = leftRemoved.filter((line) => line.rule === null)

const declared: Line[] = []
const declarations = [...declaredText]
const undeclared = (line: Line) => {
  const at = declarations.indexOf(line.text)
  if (at === -1) return true
  declarations.splice(at, 1)
  declared.push(line)
  return false
}
leftAdded = leftAdded.filter(undeclared)
leftRemoved = leftRemoved.filter(undeclared)

// Re-wrapped: what is left, joined file by file and taken apart into tokens, without whitespace
// or a comma before a closing bracket, is the same on both sides. A wrapped line may have gained
// its `pub(super) ` or `export ` too.
const tokens = (lines: Line[], strip: boolean) => {
  const counts = new Map<string, number>()
  const byFile = Map.groupBy(
    [...lines].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    (line) => line.path,
  )
  for (const lines of byFile.values()) {
    const lang = lines[0]?.lang ?? 'ts'
    const visibility = strip ? VISIBILITY[lang] : null
    const text = lines.map((line) => (visibility ? line.text.replace(visibility, '') : line.text)).join('\n')
    const all = text.match(TOKEN[lang]) ?? []
    all.forEach((token, i) => {
      if (token === ',' && /^[)\]}>]$/.test(all[i + 1] ?? '')) return
      counts.set(token, (counts.get(token) ?? 0) + 1)
    })
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).join('\n')
}
const rewrapped: Line[] = []
if (leftAdded.length + leftRemoved.length > 0 && tokens(leftAdded, true) === tokens(leftRemoved, false)) {
  for (const line of leftAdded) if (VISIBILITY[line.lang]?.test(line.text)) visible.push(line)
  rewrapped.push(...leftAdded, ...leftRemoved)
  leftAdded = []
  leftRemoved = []
}

const byPlace = (a: Line, b: Line) => a.path.localeCompare(b.path) || a.line - b.line
const list = (heading: string, lines: string[], log: (text: string) => void) => {
  if (lines.length > 0) log(`\n${heading}:\n  ${lines.join('\n  ')}`)
}
console.warn(`Move check, ${base.slice(0, 12)}..${head}:
  ${moved} lines moved
  ${allowed.boilerplate.length} module boilerplate
  ${allowed.header.length} file header
  ${allowed.banner.length} section banners removed
  ${visible.length} made visible to siblings
  ${declared.length} declared
  ${rewrapped.length} re-wrapped
  ${skipped.length} files skipped
  ${shrunk.length} baseline shrunk`)
list('Made visible to siblings', visible.sort(byPlace).map(where), console.warn)
list('Declared', declared.sort(byPlace).map(where), console.warn)
list('Re-wrapped', rewrapped.sort(byPlace).map(where), console.warn)
list('Skipped', skipped, console.warn)
list('Baseline shrunk', shrunk, console.warn)
list(
  'Changed outside source in apps/, packages/ and scripts/ (a move edits no other file)',
  outside,
  console.error,
)
list('Added, not moved', leftAdded.sort(byPlace).map(where), console.error)
list('Removed, not moved', leftRemoved.sort(byPlace).map(where), console.error)
if (declaredText.length > MAX_DECLARED)
  console.error(
    `\n${declaredText.length} lines declared under "## Not a move": past ${MAX_DECLARED} it isn't a move`,
  )

const failed =
  outside.length + leftAdded.length + leftRemoved.length > 0 || declaredText.length > MAX_DECLARED
console.warn(failed ? '\nFAIL this is not only a move' : '\nok   only moved')
process.exit(failed ? 1 : 0)
