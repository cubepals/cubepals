/**
 * Keeps Blockly's structure from getting worse. Run: bun run check:structure [--rust] [--update]
 *
 * Every check reads source files (.rs, .ts, .tsx and .py under apps/, packages/ and scripts/; not
 * lockfiles, generated code, migrations, fixtures or vendored files) and holds them to:
 * - size: a file at most 800 lines; an `impl` block, class or function at most 600, and a method
 *   inside one too. A block opens on a line and closes on the next closer at the same indentation,
 *   which the formatters guarantee; in Python it ends where the indentation does.
 * - complexity: Biome's noExcessiveCognitiveComplexity and noExcessiveLinesPerFunction, their
 *   thresholds in biome.json (off there, so `bun run lint` passes without them), and with --rust,
 *   clippy's too_many_lines, cognitive_complexity and too_many_arguments, their thresholds in
 *   apps/blocklyd/clippy.toml. Keyed by file and the function the linter points at.
 * - names: no file or directory named utils, helpers, misc, common or shared.
 * - headers: a file over 50 lines opens with a doc comment: `//!`, a `/** … *\/` block before any
 *   code, a module docstring. That one is there, never what it says.
 * - indexes: a header's ``Parts (`dir/`):`` list names exactly the source files in that directory
 *   (tests may be listed or not), each with a description; a directory beside the file of its name
 *   has such a list.
 * - cycles: no import cycle between TypeScript modules, `import type` included: a cycle of types
 *   is the same tangle for a reader. Nor between the Rust crate's modules, read from its `use`
 *   lines; a path written out in code (`crate::a::f()`) and a macro's imports go unseen.
 * - unused: no file, export or dependency that nothing uses, as knip finds them from the entry
 *   points knip.jsonc names; keyed by file and name, a dependency by its package.json.
 * - duplicates: no block of TypeScript written twice, 12 lines and 80 tokens or more (jscpd), tests
 *   aside; keyed by the two files, its number the lines they share.
 *
 * It is a ratchet. What broke a rule before the rule existed is in structure-baseline.json, with
 * its number (`n`) and a reason. A check fails on a new violation, on a baselined one that grew, on
 * an entry whose number went down (lower it with --update, which only ever lowers numbers and never
 * adds an entry), on an entry that no longer violates (remove it), and on an entry without a
 * reason. A new entry is written by hand, with its reason.
 *
 * A repository that is one Rust crate at its root, as blocklyd's is, gets the same checks on its
 * src/, tests/, examples/ and benches/: size, names, headers, indexes and cycles, and clippy's with
 * --rust. Its baseline is structure-baseline.json beside Cargo.toml, and Biome, knip and jscpd,
 * which read TypeScript, don't run. blocklyd's CI fetches this file to run it.
 *
 * The clippy checks need cargo, so they run only with --rust, in blocklyd.yml's check job, and
 * nothing else does then; the rest run in ci.yml. Layering is check-boundaries.ts's, and proving a
 * move is check-move-only.ts's.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

type Lang = 'rust' | 'ts' | 'py'
type Finding = { key: string; n?: number; limit?: number; message: string }
type Entry = { n?: number; reason?: string }
type Block = { name: string; start: number; end: number }

const SOURCE: Record<string, Lang> = { rs: 'rust', ts: 'ts', tsx: 'ts', py: 'py' }
const SKIPPED =
  /(^|\/)(bun\.lockb?|Cargo\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock)$|(^|\/)(generated|migrations|fixtures|__fixtures__|__snapshots__|vendor|vendored)\//
const FILE_LINES = 800
const BLOCK_LINES = 600
const HEADER_AFTER = 50
const VAGUE = /^(utils|helpers|misc|common|shared)$/i
/**
 * A clone this long or longer is code written twice. Shorter, jscpd finds a file's block of imports
 * and a port's signatures restated by its adapters, which no fold would make clearer.
 */
const CLONE_LINES = 12
const CLONE_TOKENS = 80
const BIOME_RULES = ['noExcessiveCognitiveComplexity', 'noExcessiveLinesPerFunction']
const RUST_LINTS = ['too_many_lines', 'cognitive_complexity', 'too_many_arguments']

/** What opens or closes a string or a comment. Rust's `'` is a lifetime unless it closes a char. */
const TOKENS: Record<Lang, RegExp> = {
  ts: /\/\/|\/\*|\*\/|\\.|`|"|'/g,
  rust: /\/\/|\/\*|\*\/|\\.|"|'(?:\\.|[^\\'])'/g,
  py: /#|\\.|"""|'''|"|'/g,
}
/** A line that may open a class, an `impl`, a function, a method or a test's body. */
const OPENS: Record<Lang, RegExp> = {
  ts: /\b(class|interface|enum|namespace|function)\b|=>|^(?!(return|if|else|for|while|switch|catch|await|yield|new|typeof|do|try)\b)[#\w][\w.]*\s*(<.*>)?\(/,
  rust: /^(pub(\([^)]*\))?\s+)?((async|const|unsafe|default|extern\s+"\w+")\s+)*(impl|fn|trait|mod)\b/,
  py: /^(async\s+)?(def|class)\s/,
}
/** How a block is named from the line that opens it; failing all of these, by the line itself. */
const NAMES: Record<Lang, Array<[RegExp, (m: RegExpExecArray) => string]>> = {
  rust: [
    [/\bimpl(?:<[^>]*>)?\s+(.+?)\s*(?:\{|\bwhere\b|$)/, (m) => `impl ${m[1]}`],
    [/\b(fn|trait|mod)\s+(\w+)/, (m) => `${m[1]} ${m[2]}`],
  ],
  py: [[/\b(def|class)\s+(\w+)/, (m) => `${m[1]} ${m[2]}`]],
  ts: [
    [/\b(class|interface|enum|namespace|function\*?)\s+(\w+)/, (m) => `${m[1]} ${m[2]}`],
    [/^((?:describe|test|it)\b[\w.]*)(?:\([^)]*\))?\(\s*(['"`])(.*?)\2/, (m) => `${m[1]} ${m[3]}`],
    [/^(?:export\s+)?(?:const|let|var)\s+(\w+)/, (m) => m[1] ?? ''],
    [
      /^(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*\*?(?!(?:return|if|for|while|switch|catch|await|new|async)\b)(#?\w+)\s*(?:<.*>)?\s*[(=]/,
      (m) => m[1] ?? '',
    ],
  ],
}

const args = process.argv.slice(2)
const rust = args.includes('--rust')
const update = args.includes('--update')
const root = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel']).stdout.toString().trim() || '.'
const crateRepo = existsSync(join(root, 'Cargo.toml'))
const BASELINE = join(root, crateRepo ? 'structure-baseline.json' : 'scripts/structure-baseline.json')
const SCOPE = crateRepo ? /^(src|tests|examples|benches)\// : /^(apps|packages|scripts)\//

const all = Bun.spawnSync(
  ['git', '-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root },
)
  .stdout.toString()
  .split('\0')
  .filter((path) => SCOPE.test(path) && !SKIPPED.test(path))
  .filter((path) => existsSync(join(root, path)))
  .sort()
const langOf = (path: string): Lang | undefined => SOURCE[path.split('.').pop() ?? '']
const sources = all.filter((path) => langOf(path) !== undefined)
const text = new Map(sources.map((path) => [path, readFileSync(join(root, path), 'utf8')]))
const linesOf = (path: string) => (text.get(path) ?? '').replace(/\n$/, '').split('\n')

const findings: Record<string, Finding[]> = {}
function report(check: string, finding: Finding) {
  findings[check] ??= []
  const same = findings[check].find((f) => f.key === finding.key)
  // Two functions of one name in a file share a key: the larger stands for both.
  if (same === undefined) findings[check].push(finding)
  else if ((finding.n ?? 0) > (same.n ?? 0)) Object.assign(same, finding)
}

/** What a string or comment left open at `open` is after `token`; 'stop' ends the line. */
function step(lang: Lang, open: string | null, token: string): string | null {
  if (open !== null) return token === open ? null : open
  if (token === '//' || token === '#') return 'stop'
  if (token === '*/' || token.startsWith('\\') || (lang === 'rust' && token.startsWith("'"))) return null
  return token === '/*' ? '*/' : token
}

/** Which lines start inside a string or a block comment, so text at column 0 isn't read as code. */
function quoted(lang: Lang, lines: string[]): boolean[] {
  const inside: boolean[] = []
  let open: string | null = null
  for (const line of lines) {
    inside.push(open !== null)
    for (const [token] of line.matchAll(TOKENS[lang])) {
      open = step(lang, open, token)
      if (open === 'stop') break
    }
    // Only a template literal, a block comment, a docstring and a Rust string go past their line.
    if (open === 'stop' || open === "'" || (open === '"' && lang !== 'rust')) open = null
  }
  return inside
}

function nameOf(lang: Lang, line: string): string {
  const t = line.trim()
  for (const [pattern, name] of NAMES[lang]) {
    const match = pattern.exec(t)
    if (match) return name(match)
  }
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}

/** The line closing a block that opens on line `i`, or -1 when no line of its own closes it. */
function endOf(lines: string[], code: (i: number) => boolean, i: number): number {
  const indent = (j: number) => (lines[j] ?? '').length - (lines[j] ?? '').trimStart().length
  for (let j = i + 1; j < lines.length; j++) {
    if (!code(j) || indent(j) > indent(i)) continue
    if (indent(j) < indent(i)) return -1
    const t = (lines[j] ?? '').trim()
    if (/^[}\])]/.test(t) && !/([{([]|=>)$/.test(t)) return j
    // A signature's own lines (`) -> T {`, `where`) sit at the block's indentation too.
    if (!/^([)>\]]|where\b|->)/.test(t)) return -1
  }
  return -1
}

/** The last line of a Python block that opens on line `i`: the last indented under it. */
function pyEndOf(lines: string[], code: (i: number) => boolean, i: number): number {
  const indent = (j: number) => (lines[j] ?? '').length - (lines[j] ?? '').trimStart().length
  let end = -1
  for (let j = i + 1; j < lines.length && (!code(j) || indent(j) > indent(i)); j++) if (code(j)) end = j
  return end
}

/** Every block in a file, each named under the blocks around it (`class X › method`). */
function blocks(path: string): Block[] {
  const lang = langOf(path) as Lang
  const lines = linesOf(path)
  const inside = quoted(lang, lines)
  const code = (i: number) => !inside[i] && (lines[i] ?? '').trim() !== ''
  const found: Block[] = []
  for (const [i, line] of lines.entries()) {
    const t = line.trim()
    if (!code(i) || /^(\/\/|\/\*|\*|#)/.test(t) || !OPENS[lang].test(t)) continue
    const end = lang === 'py' ? pyEndOf(lines, code, i) : endOf(lines, code, i)
    if (end > i) found.push({ name: nameOf(lang, t), start: i + 1, end: end + 1 })
  }
  return found.map((block) => ({
    ...block,
    name: found
      .filter((around) => around.start <= block.start && around.end >= block.end)
      .map((around) => around.name)
      .join(' › '),
  }))
}

/** The function a linter points at by its line: the innermost block opening there. */
function functionAt(path: string, line: number, known: Map<string, Block[]>): string {
  if (!known.has(path)) known.set(path, blocks(path))
  const at = known.get(path)?.filter((block) => block.start === line) ?? []
  return at.at(-1)?.name ?? nameOf(langOf(path) ?? 'ts', linesOf(path)[line - 1] ?? `line ${line}`)
}

function checkSize() {
  for (const path of sources) {
    const lines = linesOf(path)
    if (lines.length > FILE_LINES)
      report('size', { key: path, n: lines.length, limit: FILE_LINES, message: 'lines in the file' })
    for (const block of blocks(path).filter((b) => b.end - b.start + 1 > BLOCK_LINES))
      report('size', {
        key: `${path} › ${block.name}`,
        n: block.end - block.start + 1,
        limit: BLOCK_LINES,
        message: `lines in one block, from line ${block.start}`,
      })
  }
}

function checkBiome() {
  const run = Bun.spawnSync(
    [
      join(import.meta.dir, '../node_modules/.bin/biome'),
      'lint',
      ...BIOME_RULES.map((rule) => `--only=complexity/${rule}`),
      '--reporter=json',
      '--max-diagnostics=none',
      '--colors=off',
      ...['apps', 'packages', 'scripts'].filter((dir) => existsSync(join(root, dir))),
    ],
    { cwd: root, stderr: 'pipe' },
  )
  const out = run.stdout.toString()
  if (!out.startsWith('{')) {
    console.error(`biome lint failed: ${run.stderr.toString().trim()}`)
    process.exit(1)
  }
  type Diagnostic = { category: string; message: string; location: { path: string; start: { line: number } } }
  const known = new Map<string, Block[]>()
  for (const { category, message, location } of JSON.parse(out).diagnostics as Diagnostic[]) {
    const rule = category.split('/').pop() ?? ''
    if (!BIOME_RULES.includes(rule) || !text.has(location.path)) continue
    const [n, limit] = (/(\d+)\D+(\d+)/.exec(message) ?? []).slice(1).map(Number)
    report(rule, {
      key: `${location.path} › ${functionAt(location.path, location.start.line, known)}`,
      n,
      limit,
      message: rule === 'noExcessiveLinesPerFunction' ? 'lines in the function' : 'cognitive complexity',
    })
  }
}

function checkClippy() {
  const crate = crateRepo ? root : join(root, 'apps/blocklyd')
  const lints = RUST_LINTS.flatMap((lint) => ['-W', `clippy::${lint}`])
  const run = Bun.spawnSync(
    ['cargo', 'clippy', '--locked', '--all-targets', '--message-format=json', '--', ...lints],
    { cwd: crate, stderr: 'pipe' },
  )
  if (run.exitCode !== 0) {
    console.error(`cargo clippy failed:\n${run.stderr.toString().trim()}`)
    process.exit(1)
  }
  type Message = {
    code?: { code: string }
    message: string
    spans: Array<{ file_name: string; line_start: number; is_primary: boolean }>
  }
  const known = new Map<string, Block[]>()
  for (const line of run.stdout
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('{'))) {
    const message: Message | undefined = JSON.parse(line).message
    const lint = message?.code?.code.replace(/^clippy::/, '') ?? ''
    const span = message?.spans.find((s) => s.is_primary)
    if (message === undefined || span === undefined || !RUST_LINTS.includes(lint)) continue
    const path = relative(root, resolve(crate, span.file_name))
    const [n, limit] = (/\((\d+)\/(\d+)\)/.exec(message.message) ?? []).slice(1).map(Number)
    if (text.has(path))
      report(`clippy::${lint}`, {
        key: `${path} › ${functionAt(path, span.line_start, known)}`,
        n,
        limit,
        message:
          { too_many_lines: 'lines in the function', too_many_arguments: 'arguments' }[lint] ??
          'cognitive complexity',
      })
  }
}

function checkNames() {
  for (const path of all) {
    const parts = path.split('/')
    for (const [i, part] of parts.entries())
      if (VAGUE.test(part.split('.')[0] ?? ''))
        report('names', {
          key: parts.slice(0, i + 1).join('/'),
          message: 'is named for a category, not for its job',
        })
  }
}

/** Whether a file opens with its doc comment. Only a `#!` line, a directive or a comment may come first. */
function hasHeader(lang: Lang, lines: string[]): boolean {
  const skipped = {
    rust: /^(#!|$)/,
    ts: /^(#!|['"]use (client|server)['"];?$|\/\/|$)/,
    py: /^(#|$)/,
  }[lang]
  const first = lines.find((line) => !skipped.test(line.trim()))?.trim() ?? ''
  if (lang === 'rust') return first.startsWith('//!')
  if (lang === 'py') return /^[rRuU]?("""|''')/.test(first)
  return first.startsWith('/**')
}

function checkHeaders() {
  for (const path of sources) {
    const lines = linesOf(path)
    if (lines.length > HEADER_AFTER && !hasHeader(langOf(path) as Lang, lines))
      report('headers', { key: path, message: `has ${lines.length} lines and no header comment` })
  }
}

/** The doc comment a file opens with, each line without its comment marker. */
function header(path: string): Array<{ line: number; text: string }> {
  const lang = langOf(path) as Lang
  const lines = linesOf(path).map((text, i) => ({ line: i + 1, text }))
  if (lang === 'rust') {
    const start = lines.findIndex(({ text }) => text.startsWith('//!'))
    const end = lines.findIndex(({ text }, i) => i > start && !text.startsWith('//!'))
    return start === -1
      ? []
      : lines.slice(start, end).map(({ line, text }) => ({ line, text: text.slice(3) }))
  }
  const [open, close] = lang === 'ts' ? [/^\s*\/\*\*/, /\*\//] : [/^[rRuU]?("""|''')/, /.("""|''')\s*$/]
  const start = lines.findIndex(({ text }) => open.test(text))
  const end = lines.findIndex(({ text }, i) => i >= start && close.test(text))
  return start === -1
    ? []
    : lines.slice(start, end + 1).map(({ line, text }) => ({ line, text: text.replace(/^\s*\*(?!\/)/, '') }))
}

/** The name an index line lists, reporting a line that isn't `- `file`: what it is for`. */
function listedOn(path: string, line: number, t: string): string | null {
  const item = /^- `([^`]+)`(?::\s*(.*))?$/.exec(t)
  if (item === null)
    report('indexes', { key: `${path}:${line}`, message: 'is no `- `file`: what it is for` line' })
  else if ((item[2] ?? '').trim() === '')
    report('indexes', { key: `${path} › ${item[1]}`, message: 'is listed without a description' })
  return item?.[1] ?? null
}

/** The directory a header's ``Parts (`dir/`):`` list indexes, and the names it lists; null without one. */
function indexOf(path: string): { dir: string; listed: string[] } | null {
  const lines = header(path)
  const at = lines.findIndex(({ text }) => /^\s*Parts \(`[^`]+\/`\):\s*$/.test(text))
  if (at === -1) return null
  const dir = join(dirname(path), /`([^`]+)\/`/.exec(lines[at]?.text ?? '')?.[1] ?? '')
  const listed: string[] = []
  for (const { line, text } of lines.slice(at + 1)) {
    const t = text.replace(/\*\/\s*$|("""|''')\s*$/, '').trim()
    if (t === '') break
    // A description too long for one line goes on under its item, indented.
    const name = /^\s{2,}\S/.test(text) && listed.length > 0 ? null : listedOn(path, line, t)
    if (name !== null) listed.push(name)
  }
  return { dir, listed }
}

function checkIndexes() {
  const indexed = new Set<string>()
  const isTest = (name: string) => /\.test\.tsx?$/.test(name)
  for (const path of sources) {
    const index = indexOf(path)
    if (index === null) continue
    const { dir, listed } = index
    indexed.add(dir)
    const onDisk = sources.filter((p) => dirname(p) === dir).map((p) => basename(p))
    for (const name of onDisk.filter((name) => !listed.includes(name) && !isTest(name)))
      report('indexes', { key: `${path} › ${name}`, message: `is in ${dir}/ but not in its index` })
    for (const name of listed.filter((name) => !onDisk.includes(name)))
      report('indexes', { key: `${path} › ${name}`, message: `is in the index but not in ${dir}/` })
  }
  // A split's directory sits beside the file of its name, whose header keeps the index.
  for (const path of sources) {
    const dir = path.replace(/\.(rs|tsx?|py)$/, '')
    if (!indexed.has(dir) && sources.some((p) => p.startsWith(`${dir}/`)))
      report('indexes', {
        key: path,
        message: `has no \`Parts (\`${basename(dir)}/\`):\` index in its header`,
      })
  }
}

/** Each workspace package's import names, with the files its exports point at. */
function packages(): Map<string, string> {
  const exported = new Map<string, string>()
  for (const manifest of all.filter((p) => /^(apps|packages)\/[^/]+\/package\.json$/.test(p))) {
    const pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8'))
    const map = typeof pkg.exports === 'string' ? { '.': pkg.exports } : (pkg.exports ?? {})
    for (const [sub, target] of Object.entries(map))
      if (typeof target === 'string') exported.set(join(pkg.name, sub), join(dirname(manifest), target))
  }
  return exported
}

/** Each TypeScript module's static imports and re-exports, types too, as the files they resolve to. */
function tsImports(): Map<string, string[]> {
  const exported = packages()
  const graph = new Map<string, string[]>()
  const statement =
    /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
  for (const path of sources.filter((p) => langOf(p) === 'ts')) {
    const source = (text.get(path) ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
    const targets = [...source.matchAll(statement)].flatMap((match) => {
      const spec = match[1] ?? match[2] ?? ''
      const base = spec.startsWith('.')
        ? join(dirname(path), spec).replace(/\.js$/, '.ts')
        : exported.get(spec)
      if (base === undefined) return []
      const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
      return candidates.filter((candidate) => text.has(candidate)).slice(0, 1)
    })
    graph.set(path, targets)
  }
  return graph
}

/** The file of a Rust path (`crate::a::b::Item`): that of its longest prefix that is a module file. */
function rustFile(crate: string, path: string[]): string | undefined {
  for (let n = path.length; n > 1; n--) {
    const rel = path.slice(1, n).join('/')
    const file = [`${crate}/${rel}.rs`, `${crate}/${rel}/mod.rs`].find((candidate) => text.has(candidate))
    if (file !== undefined) return file
  }
  return undefined
}

/** The files a `use` names from the module at `here`, by their paths' longest prefixes that are files. */
function useTargets(crate: string, here: string[], used: string, group: string | undefined): string[] {
  let at = used.startsWith('crate') ? ['crate'] : here
  for (const part of used.split('::').filter((p) => p !== 'crate' && p !== 'self'))
    at = part === 'super' ? at.slice(0, -1) : [...at, part]
  const items = group?.split(',').map((item) => item.trim().split(/::|\s/)[0] ?? '') ?? ['']
  return items.flatMap((item) => rustFile(crate, item === '' || item === 'self' ? at : [...at, item]) ?? [])
}

/**
 * Each Rust module's `use` lines, re-exports too, as the files of the modules they name. A path
 * starts at the crate's root (`crate::`) or at this module (`super::`, `self::`, a child's name); a
 * dependency's or std's names no file, and one naming this file's own items is no edge.
 */
function rustImports(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const path of sources.filter((p) => /(^|\/)src\/.*\.rs$/.test(p) && !/(^|\/)src\/bin\//.test(p))) {
    const [crate = '', rel = ''] = path.split(/(?<=(?:^|\/)src)\//)
    const here = ['crate', ...rel.replace(/(^|\/)(lib|main|mod)\.rs$|\.rs$/, '').split('/')].filter(Boolean)
    // An inline `mod tests` reaches its parent through `use super::*`, which is no edge.
    const source = (text.get(path) ?? '')
      .replace(/\/\/.*/g, '')
      .replace(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{[\s\S]*$/, '')
    const uses = [...source.matchAll(/\buse\s+(\w+(?:::\w+)*)(?:::\{([^;]*)\})?/g)]
    const targets = uses.flatMap(([, used = '', group]) => useTargets(crate, here, used, group))
    graph.set(
      path,
      targets.filter((file) => file !== path),
    )
  }
  return graph
}

/** Every set of files that import each other round a cycle: Tarjan's strongly connected components. */
function checkCycles(graph: Map<string, string[]>) {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const visit = (node: string) => {
    index.set(node, index.size)
    low.set(node, index.size - 1)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) visit(next)
      if (stack.includes(next)) low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0))
    }
    if (low.get(node) !== index.get(node)) return
    const component = stack.splice(stack.indexOf(node)).sort()
    if (component.length > 1)
      report('cycles', {
        key: component.join(' ↔ '),
        n: component.length,
        message: 'files that import each other',
      })
  }
  for (const node of graph.keys()) if (!index.has(node)) visit(node)
}

/** What knip says of each kind of thing it finds unused, by the key its JSON report files it under. */
const UNUSED: Record<string, string> = {
  files: 'is a file nothing imports',
  exports: 'is exported and nothing imports it',
  types: 'is an exported type nothing imports',
  nsExports: 'is exported and nothing imports it',
  nsTypes: 'is an exported type nothing imports',
  enumMembers: 'is an enum member nothing reads',
  classMembers: 'is a class member nothing reads',
  duplicates: 'is one export under several names',
  dependencies: 'is a dependency nothing imports',
  devDependencies: 'is a dependency nothing imports',
  optionalPeerDependencies: 'is a dependency nothing imports',
  unlisted: 'is imported but not in the package.json',
  binaries: 'is a program run but provided by no dependency',
  unresolved: 'is an import that resolves to nothing',
}

function checkUnused() {
  // knip reads a project, and a tree without a package.json has none.
  if (!existsSync(join(root, 'package.json'))) return
  const run = Bun.spawnSync(
    [
      join(import.meta.dir, '../node_modules/.bin/knip'),
      '--reporter',
      'json',
      '--no-progress',
      '--no-exit-code',
    ],
    { cwd: root, stderr: 'pipe' },
  )
  const out = run.stdout.toString()
  if (!out.startsWith('{')) {
    console.error(`knip failed: ${run.stderr.toString().trim()}`)
    process.exit(1)
  }
  for (const issue of JSON.parse(out).issues as Array<Record<string, unknown> & { file: string }>)
    for (const [kind, message] of Object.entries(UNUSED))
      for (const name of namesOf(issue[kind]))
        report('unused', { key: kind === 'files' ? issue.file : `${issue.file} › ${name}`, message })
}

/** The names knip lists of one kind in one file: a list of them, or a map of lists; a member by its parent. */
function namesOf(found: unknown): string[] {
  const items = (Array.isArray(found) ? found : Object.values(found ?? {})).flat()
  return items.map((item: { name: string; parentName?: string }) =>
    item.parentName ? `${item.parentName}.${item.name}` : item.name,
  )
}

function checkDuplicates() {
  const out = mkdtempSync(join(tmpdir(), 'jscpd-'))
  const skipped = ['**/node_modules/**', '**/*.test.ts', '**/*.test.tsx', '**/*.e2e.ts']
  const run = Bun.spawnSync(
    [
      join(import.meta.dir, '../node_modules/.bin/jscpd'),
      ...['--min-lines', `${CLONE_LINES}`, '--min-tokens', `${CLONE_TOKENS}`],
      ...[
        '--format',
        'typescript,tsx',
        '--ignore',
        skipped.join(','),
        '--reporters',
        'json',
        '--output',
        out,
      ],
      '.',
    ],
    { cwd: root, stderr: 'pipe' },
  )
  const json = join(out, 'jscpd-report.json')
  if (!existsSync(json)) {
    console.error(`jscpd failed: ${run.stderr.toString().trim()}`)
    process.exit(1)
  }
  type Clone = { lines: number; firstFile: { name: string }; secondFile: { name: string } }
  const clones: Clone[] = JSON.parse(readFileSync(json, 'utf8')).duplicates
  rmSync(out, { recursive: true, force: true })
  const shared = new Map<string, number>()
  for (const { lines, firstFile, secondFile } of clones) {
    const files = [...new Set([firstFile.name, secondFile.name])].sort()
    if (files.some((file) => !text.has(file))) continue
    shared.set(files.join(' ↔ '), (shared.get(files.join(' ↔ ')) ?? 0) + lines)
  }
  for (const [key, n] of shared)
    report('duplicates', {
      key,
      n,
      message: key.includes(' ↔ ') ? 'lines written in both' : 'lines written twice in the file',
    })
}

const problems: string[] = []
const lowered: string[] = []

/** A finding held to its baseline entry: the problem, or null when it holds (lowering it with --update). */
function verdict(check: string, f: Finding, entry: Entry | undefined): string | null {
  const limit = f.limit === undefined ? '' : `, limit ${f.limit}`
  if (entry === undefined) return `${check}  ${f.key}: ${[f.n, f.message].join(' ').trim()}${limit}`
  const was = entry.n ?? 0
  if (f.n === undefined || f.n === was) return null
  if (f.n > was) return `${check}  ${f.key}: grew from ${was} to ${f.n} ${f.message}${limit}`
  if (!update)
    return `${check}  ${f.key}: down from ${was} to ${f.n}; lower it with bun run check:structure --update`
  lowered.push(`${check}  ${f.key}: ${was} → ${f.n}`)
  entry.n = f.n
  return null
}

/** The ratchet for one check: what it found, held to the baseline's entries for it. */
function judge(check: string, entries: Record<string, Entry>) {
  const current = findings[check] ?? []
  for (const f of current) problems.push(verdict(check, f, entries[f.key]) ?? '')
  for (const [key, entry] of Object.entries(entries)) {
    if ((entry.reason ?? '').trim() === '') problems.push(`${check}  ${key}: baseline entry has no reason`)
    if (!current.some((f) => f.key === key))
      problems.push(`${check}  ${key}: stale baseline entry, no longer a violation; remove it`)
  }
}

if (rust) checkClippy()
else {
  checkSize()
  if (!crateRepo) checkBiome()
  checkNames()
  checkHeaders()
  checkIndexes()
  checkCycles(new Map([...tsImports(), ...rustImports()]))
  if (!crateRepo) checkUnused()
  if (!crateRepo) checkDuplicates()
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const checks = rust
  ? RUST_LINTS.map((lint) => `clippy::${lint}`)
  : crateRepo
    ? ['size', 'names', 'indexes', 'cycles']
    : ['size', ...BIOME_RULES, 'names', 'indexes', 'cycles', 'unused', 'duplicates']
for (const check of checks) judge(check, baseline[check] ?? {})
// Files without a header are one list, with one reason.
if (!rust) {
  const { reason = '', files = [] }: { reason?: string; files?: string[] } = baseline.headers ?? {}
  judge('headers', Object.fromEntries(files.map((path) => [path, { reason }])))
}

if (lowered.length > 0) {
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`)
  console.warn(`Lowered in the baseline:\n  ${lowered.join('\n  ')}`)
}
if (problems.some(Boolean)) {
  console.error(`Structure check failed:\n  ${problems.filter(Boolean).join('\n  ')}`)
  process.exit(1)
}
console.warn(rust ? 'Rust structure holds.' : 'Structure holds.')
