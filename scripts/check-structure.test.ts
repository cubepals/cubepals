/**
 * check-structure.ts against small trees: for each check, a new violation fails, a baselined one
 * passes, one that grew fails, an entry that no longer violates fails, and an entry without a
 * reason fails; --update only ever lowers a number. Clippy's part (--rust) needs a crate and cargo,
 * so it is checked by running it in blocklyd's CI, not here. A repository that is one crate is
 * checked here without it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'check-structure.ts')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** A git checkout holding `files`, the repository's biome.json, and `baseline` as its baseline. */
function tree(files: Record<string, string>, baseline: object = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'structure-'))
  made.push(dir)
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  copyFileSync(resolve(import.meta.dir, '../biome.json'), join(dir, 'biome.json'))
  for (const [path, content] of Object.entries({
    ...files,
    'scripts/structure-baseline.json': JSON.stringify(baseline),
  })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

function check(dir: string, ...args: string[]) {
  const run = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd: dir, stderr: 'pipe' })
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() }
}

const baselineOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'scripts/structure-baseline.json'), 'utf8'))
/** `n` lines of code under a header, so only the check under test has anything to say. */
const consts = (n: number) =>
  `/** Numbers. */\n${Array.from({ length: n - 1 }, (_, i) => `export const n${i} = ${i}`).join('\n')}\n`
const classOf = (n: number) =>
  `/** One class. */\nexport class Big {\n${Array.from({ length: n - 2 }, (_, i) => `  f${i} = ${i}`).join('\n')}\n}\n`

describe('size', () => {
  test('a new file over 800 lines fails, naming the number and the limit', () => {
    const { code, out } = check(tree({ 'apps/big.ts': consts(801) }))
    expect(code).toBe(1)
    expect(out).toContain('size  apps/big.ts: 801 lines in the file, limit 800')
  })

  test('a baselined one passes, and fails with both numbers once it grows', () => {
    const files = { 'apps/big.ts': consts(801) }
    const entry = (n: number) => ({ size: { 'apps/big.ts': { n, reason: 'one table' } } })
    expect(check(tree(files, entry(801))).code).toBe(0)
    const { code, out } = check(tree(files, entry(800)))
    expect(code).toBe(1)
    expect(out).toContain('apps/big.ts: grew from 800 to 801 lines in the file, limit 800')
  })

  test('a block over 600 lines fails by its name; a method inside a class counts too', () => {
    const { code, out } = check(tree({ 'apps/big.ts': classOf(602) }))
    expect(code).toBe(1)
    expect(out).toContain('apps/big.ts › class Big: 602 lines in one block, from line 2, limit 600')
    const method = `/** One method. */\nexport class Small {\n  big() {\n${'    this.x()\n'.repeat(600)}  }\n}\n`
    expect(check(tree({ 'apps/m.ts': method })).out).toContain('apps/m.ts › class Small › big: 602 lines')
  })

  test('a Rust impl and a Python function are measured by their indentation', () => {
    const rust = `//! One impl.\nimpl Big {\n${'    const A: u8 = 0;\n'.repeat(600)}}\n`
    const python = `"""One function."""\n\n\ndef big():\n${'    x = 1\n\n'.repeat(300)}    return x\n\n\ny = 2\n`
    const { out } = check(tree({ 'apps/k/src/big.rs': rust, 'scripts/big.py': python }))
    expect(out).toContain('apps/k/src/big.rs › impl Big: 602 lines in one block')
    expect(out).toContain('scripts/big.py › def big: 602 lines in one block')
  })

  test('a template literal at column 0 inside a function is no closer', () => {
    const source = `/** A fixture. */\nexport function big() {\n  const t = \`\n}\n\`\n${'  void t\n'.repeat(600)}}\n`
    expect(check(tree({ 'apps/t.ts': source })).out).toContain('apps/t.ts › function big: 605 lines')
  })

  test('an entry no longer over the limit is stale, and one without a reason fails', () => {
    const stale = check(
      tree({ 'apps/big.ts': consts(700) }, { size: { 'apps/big.ts': { n: 801, reason: 'x' } } }),
    )
    expect(stale.code).toBe(1)
    expect(stale.out).toContain('size  apps/big.ts: stale baseline entry')
    const bare = check(
      tree({ 'apps/big.ts': consts(801) }, { size: { 'apps/big.ts': { n: 801, reason: ' ' } } }),
    )
    expect(bare.code).toBe(1)
    expect(bare.out).toContain('size  apps/big.ts: baseline entry has no reason')
  })

  test('generated code, migrations and fixtures are out of scope', () => {
    const files = { 'apps/x/generated/api.ts': consts(900), 'packages/db/migrations/m.ts': consts(900) }
    expect(check(tree({ ...files, 'apps/fixtures/f.ts': consts(900) })).code).toBe(0)
  })
})

describe('--update', () => {
  test('lowers a number that went down, and nothing else', () => {
    const dir = tree(
      { 'apps/big.ts': consts(820), 'apps/bigger.ts': consts(900), 'apps/new.ts': consts(850) },
      { size: { 'apps/big.ts': { n: 830, reason: 'kept' }, 'apps/bigger.ts': { n: 880, reason: 'kept' } } },
    )
    const before = check(dir)
    expect(before.out).toContain('apps/big.ts: down from 830 to 820')
    const { code, out } = check(dir, '--update')
    expect(code).toBe(1)
    expect(out).toContain('apps/big.ts: 830 → 820')
    expect(baselineOf(dir).size).toEqual({
      'apps/big.ts': { n: 820, reason: 'kept' },
      'apps/bigger.ts': { n: 880, reason: 'kept' },
    })
    expect(out).toContain('apps/bigger.ts: grew from 880 to 900')
    expect(out).toContain('apps/new.ts: 850 lines in the file')
  })

  test('leaves the baseline untouched when nothing went down', () => {
    const dir = tree({ 'apps/big.ts': consts(801) }, { size: { 'apps/big.ts': { n: 801, reason: 'kept' } } })
    const before = readFileSync(join(dir, 'scripts/structure-baseline.json'), 'utf8')
    expect(check(dir, '--update').code).toBe(0)
    expect(readFileSync(join(dir, 'scripts/structure-baseline.json'), 'utf8')).toBe(before)
  })
})

describe('complexity', () => {
  const busy = (ifs: number) =>
    `/** Busy. */\nexport function busy(a: number): number {\n  let n = 0\n${Array.from({ length: ifs }, (_, i) => `  if (a === ${i}) n++`).join('\n')}\n  return n\n}\n`
  const long = (lines: number) =>
    `/** Long. */\nexport function long(): number {\n  let n = 0\n${'  n++\n'.repeat(lines - 2)}  return n\n}\n`

  test("Biome's cognitive complexity fails a new function, keyed by file and name", () => {
    const { code, out } = check(tree({ 'apps/c.ts': busy(16) }))
    expect(code).toBe(1)
    expect(out).toContain(
      'noExcessiveCognitiveComplexity  apps/c.ts › function busy: 16 cognitive complexity, limit 15',
    )
  })

  test('a baselined one passes, fails once it grows, and is stale once under the limit', () => {
    const entry = (n: number) => ({
      noExcessiveCognitiveComplexity: { 'apps/c.ts › function busy': { n, reason: 'a table of cases' } },
    })
    expect(check(tree({ 'apps/c.ts': busy(16) }, entry(16))).code).toBe(0)
    expect(check(tree({ 'apps/c.ts': busy(17) }, entry(16))).out).toContain(
      'grew from 16 to 17 cognitive complexity',
    )
    expect(check(tree({ 'apps/c.ts': busy(15) }, entry(16))).out).toContain('stale baseline entry')
    const bare = { noExcessiveCognitiveComplexity: { 'apps/c.ts › function busy': { n: 16 } } }
    expect(check(tree({ 'apps/c.ts': busy(16) }, bare)).out).toContain('baseline entry has no reason')
  })

  test("Biome's lines per function fails a function over 100 lines", () => {
    const { code, out } = check(tree({ 'apps/l.ts': long(101) }))
    expect(code).toBe(1)
    expect(out).toContain(
      'noExcessiveLinesPerFunction  apps/l.ts › function long: 101 lines in the function, limit 100',
    )
  })
})

describe('names', () => {
  test('a file or a directory named for a category fails unless baselined', () => {
    const files = {
      'apps/web/utils.ts': 'export const a = 1\n',
      'packages/helpers/x.ts': 'export const b = 1\n',
    }
    const { code, out } = check(tree(files))
    expect(code).toBe(1)
    expect(out).toContain('names  apps/web/utils.ts: is named for a category')
    expect(out).toContain('names  packages/helpers: is named for a category')
    const both = { 'apps/web/utils.ts': { reason: 'x' }, 'packages/helpers': { reason: 'y' } }
    expect(check(tree(files, { names: both })).code).toBe(0)
  })

  test('a renamed file leaves a stale entry, and an entry needs a reason', () => {
    const files = { 'apps/web/strings.ts': 'export const a = 1\n' }
    expect(check(tree(files, { names: { 'apps/web/utils.ts': { reason: 'x' } } })).out).toContain(
      'stale baseline entry',
    )
    const bare = check(tree({ 'apps/common.ts': '' }, { names: { 'apps/common.ts': { reason: '' } } }))
    expect(bare.out).toContain('apps/common.ts: baseline entry has no reason')
  })
})

describe('headers', () => {
  // Lines that differ, so no two runs of them are a duplicate.
  const body = Array.from({ length: 51 }, (_, i) => `export const a${i} = ${i}\n`).join('')

  test('a file over 50 lines without a doc comment first fails; a list with a reason holds it', () => {
    const { code, out } = check(tree({ 'apps/a.ts': body }))
    expect(code).toBe(1)
    expect(out).toContain('headers  apps/a.ts: has 51 lines and no header comment')
    expect(
      check(tree({ 'apps/a.ts': body }, { headers: { reason: 'old', files: ['apps/a.ts'] } })).code,
    ).toBe(0)
    expect(
      check(tree({ 'apps/a.ts': body }, { headers: { reason: '', files: ['apps/a.ts'] } })).out,
    ).toContain('baseline entry has no reason')
  })

  test('a directive or a line comment may come before the block; code may not', () => {
    const ok = {
      'apps/a.tsx': `'use client'\n\n/** A page. */\n${body}`,
      'apps/b.ts': `#!/usr/bin/env bun\n// biome-ignore-all lint: x\n/** A script. */\n${body}`,
      'apps/k/src/c.rs': `//! A module.\n${'pub const A: u8 = 0;\n'.repeat(51)}`,
      'apps/k/src/f.rs': `// SPDX-License-Identifier: FSL-1.1-ALv2\n\n//! A module.\n${'pub const A: u8 = 0;\n'.repeat(51)}`,
      'scripts/d.py': `#!/usr/bin/env python3\n"""A script."""\n${'x = 1\n'.repeat(51)}`,
    }
    expect(check(tree(ok)).code).toBe(0)
    const late = check(tree({ 'apps/e.ts': `import { b } from './b.ts'\n/** Too late. */\n${body}` }))
    expect(late.out).toContain('headers  apps/e.ts')
  })

  test('a listed file that gained a header is stale', () => {
    const { code, out } = check(
      tree(
        { 'apps/a.ts': `/** Now it has one. */\n${body}` },
        { headers: { reason: 'old', files: ['apps/a.ts'] } },
      ),
    )
    expect(code).toBe(1)
    expect(out).toContain('headers  apps/a.ts: stale baseline entry')
  })
})

describe('indexes', () => {
  const index = (...items: string[]) =>
    `/**\n * Splits a thing.\n *\n * Parts (\`split/\`):\n${items.map((item) => ` * ${item}`).join('\n')}\n */\nexport const a = 1\n`
  const parts = { 'apps/split/a.ts': 'export const a = 1\n', 'apps/split/b.ts': 'export const b = 1\n' }

  test('an index that matches its directory passes, tests listed or not; Rust writes the same lines', () => {
    const ts = {
      'apps/split.ts': index('- `a.ts`: one part.', '- `b.ts`: the other,', '  going on.'),
      ...parts,
    }
    const rust = {
      'apps/k/src/manager.rs':
        '//! The manager.\n//!\n//! Parts (`manager/`):\n//! - `ensure.rs`: ensures.\n\nmod ensure;\n',
      'apps/k/src/manager/ensure.rs': '//! Ensures.\n',
    }
    expect(check(tree({ ...ts, ...rust, 'apps/split/a.test.ts': '' })).code).toBe(0)
  })

  test('a file not listed, a listed file not on disk and an item without a description fail', () => {
    const files = { 'apps/split.ts': index('- `a.ts`:', '- `c.ts`: gone.'), ...parts }
    const { code, out } = check(tree(files))
    expect(code).toBe(1)
    expect(out).toContain('indexes  apps/split.ts › a.ts: is listed without a description')
    expect(out).toContain('indexes  apps/split.ts › b.ts: is in apps/split/ but not in its index')
    expect(out).toContain('indexes  apps/split.ts › c.ts: is in the index but not in apps/split/')
  })

  test("a Rust dir/mod.rs is its directory's index, and it lists its directory's other files", () => {
    const mod = (...items: string[]) =>
      `//! The fleet.\n//!\n//! Parts (\`fleet/\`):\n${items.map((item) => `//! ${item}\n`).join('')}\npub mod wire;\n`
    const files = { 'apps/k/src/fleet/wire.rs': '//! Wire.\n', 'apps/k/src/fleet/token.rs': '//! Token.\n' }
    const listed = mod('- `token.rs`: tokens.', '- `wire.rs`: the wire.')
    expect(check(tree({ ...files, 'apps/k/src/fleet/mod.rs': listed })).code).toBe(0)
    const short = check(tree({ ...files, 'apps/k/src/fleet/mod.rs': mod('- `wire.rs`: the wire.') }))
    expect(short.out).toContain(
      'indexes  apps/k/src/fleet/mod.rs › token.rs: is in apps/k/src/fleet/ but not',
    )
    const none = check(tree({ ...files, 'apps/k/src/fleet/mod.rs': '//! The fleet.\npub mod wire;\n' }))
    expect(none.out).toContain('indexes  apps/k/src/fleet/mod.rs: has no `Parts (`fleet/`):` index')
    expect(check(tree({ 'apps/k/src/alone/mod.rs': '//! Alone.\n' })).code).toBe(0)
  })

  test('a directory beside the file of its name without an index fails unless baselined', () => {
    const files = { 'apps/split.ts': '/** Splits a thing. */\nexport const a = 1\n', ...parts }
    expect(check(tree(files)).out).toContain('indexes  apps/split.ts: has no `Parts (`split/`):` index')
    expect(check(tree(files, { indexes: { 'apps/split.ts': { reason: 'x' } } })).code).toBe(0)
    const fixed = { ...files, 'apps/split.ts': index('- `a.ts`: one.', '- `b.ts`: two.') }
    expect(check(tree(fixed, { indexes: { 'apps/split.ts': { reason: 'x' } } })).out).toContain(
      'stale baseline entry',
    )
  })
})

describe('cycles', () => {
  const cycle = {
    'apps/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
    'apps/b.ts': "import type { A } from './c'\nexport const b = 1\nexport type B = A\n",
    'apps/c/index.ts': "export { a } from '../a.ts'\nexport type A = number\n",
  }
  const key = 'apps/a.ts ↔ apps/b.ts ↔ apps/c/index.ts'

  test('modules importing each other fail, type imports and re-exports included', () => {
    const { code, out } = check(tree(cycle))
    expect(code).toBe(1)
    expect(out).toContain(`cycles  ${key}: 3 files that import each other`)
  })

  test('a baselined cycle passes, fails once it takes in another file, and is stale once broken', () => {
    expect(check(tree(cycle, { cycles: { [key]: { n: 3, reason: 'x' } } })).code).toBe(0)
    const grown = {
      ...cycle,
      'apps/b.ts': `import './d.ts'\n${cycle['apps/b.ts']}`,
      'apps/d.ts': "import './a.ts'\n",
    }
    const { out } = check(tree(grown, { cycles: { [key]: { n: 3, reason: 'x' } } }))
    expect(out).toContain('apps/a.ts ↔ apps/b.ts ↔ apps/c/index.ts ↔ apps/d.ts: 4 files')
    expect(out).toContain(`cycles  ${key}: stale baseline entry`)
    const broken = { ...cycle, 'apps/a.ts': 'export const a = 1\n' }
    expect(check(tree(broken, { cycles: { [key]: { n: 3, reason: 'x' } } })).out).toContain(
      'stale baseline entry',
    )
  })

  test("Rust modules' use lines make the graph: crate::, super:: and a child's name", () => {
    const crate = {
      'apps/k/src/lib.rs': '//! A crate.\nmod a;\nmod b;\n',
      'apps/k/src/a.rs':
        '//! A.\n//!\n//! Parts (`a/`):\n//! - `part.rs`: the thing.\n\nmod part;\npub use part::Thing;\n',
      'apps/k/src/a/part.rs': '//! A part.\nuse crate::b::{Other, self};\npub struct Thing;\n',
      'apps/k/src/b.rs': '//! B.\nuse super::a::Thing;\npub struct Other;\n',
    }
    const { code, out } = check(tree(crate))
    expect(code).toBe(1)
    // a/part.rs using b is a using b: the cycle is between the modules, each its file and what is under it.
    expect(out).toContain('cycles  apps/k/src/a.rs ↔ apps/k/src/b.rs: 2 modules that use each other')
    const apart = { ...crate, 'apps/k/src/b.rs': '//! B.\nuse std::fmt;\npub struct Other;\n' }
    expect(check(tree(apart)).code).toBe(0)
  })

  test('a path written in code, a nested group and a mod.rs make edges too', () => {
    const crate = {
      'apps/k/src/lib.rs': '//! A crate.\nmod a;\nmod b;\nmod c;\n',
      'apps/k/src/a/mod.rs': '//! A.\n//!\n//! Parts (`a/`):\n//! - `part.rs`: the thing.\n\npub mod part;\n',
      'apps/k/src/a/part.rs': '//! A part.\npub fn f() -> u8 {\n    crate::b::g()\n}\n',
      'apps/k/src/b.rs': '//! B.\nuse crate::{c::{self, h}};\npub fn g() -> u8 { h() }\n',
      'apps/k/src/c.rs': '//! C.\npub fn h() -> u8 {\n    super::a::part::f()\n}\n',
    }
    const { code, out } = check(tree(crate))
    expect(code).toBe(1)
    expect(out).toContain('cycles  apps/k/src/a/mod.rs ↔ apps/k/src/b.rs ↔ apps/k/src/c.rs: 3 modules')
    // A part using its parent, and the parent re-exporting it, is a cycle between the two.
    const parent = {
      'apps/k/src/lib.rs': '//! A crate.\nmod a;\n',
      'apps/k/src/a/mod.rs': crate['apps/k/src/a/mod.rs'].replace(
        'pub mod part;',
        'mod part;\npub use part::f;',
      ),
      'apps/k/src/a/part.rs': '//! A part.\nuse super::Shared;\npub fn f() {}\n',
    }
    expect(check(tree(parent)).out).toContain('cycles  apps/k/src/a/mod.rs ↔ apps/k/src/a/part.rs: 2 modules')
  })
})

describe('unused', () => {
  const project = {
    'package.json': JSON.stringify({ name: 't', private: true, dependencies: { 'left-pad': '1.3.0' } }),
    'knip.json': JSON.stringify({ entry: ['apps/main.ts'], project: ['apps/**/*.ts'] }),
    'apps/main.ts': "import { a } from './a.ts'\nconsole.warn(a)\n",
    'apps/a.ts': 'export const a = 1\nexport const b = 2\n',
  }

  test('a file, an export and a dependency nothing uses fail, keyed by file and name', () => {
    const { code, out } = check(tree({ ...project, 'apps/orphan.ts': 'export const c = 3\n' }))
    expect(code).toBe(1)
    expect(out).toContain('unused  apps/orphan.ts: is a file nothing imports')
    expect(out).toContain('unused  apps/a.ts › b: is exported and nothing imports it')
    expect(out).toContain('unused  package.json › left-pad: is a dependency nothing imports')
  })

  test('a baselined one passes, and is stale once something uses it', () => {
    const files = { ...project, 'package.json': JSON.stringify({ name: 't', private: true }) }
    const entry = { unused: { 'apps/a.ts › b': { reason: 'a public API' } } }
    expect(check(tree(files, entry)).code).toBe(0)
    const used = { ...files, 'apps/main.ts': "import { a, b } from './a.ts'\nconsole.warn(a, b)\n" }
    expect(check(tree(used, entry)).out).toContain('unused  apps/a.ts › b: stale baseline entry')
  })
})

describe('duplicates', () => {
  /** A function of `n` lines, the same wherever it is written. */
  const sum = (n: number) =>
    `export function sum(values: number[], offset: number): number {\n  let total = 0\n${Array.from(
      { length: n - 3 },
      (_, i) => `  total += values[${i}] * ${i} + offset`,
    ).join('\n')}\n  return total\n}\n`
  const key = 'apps/a.ts ↔ apps/b.ts'

  test('a block written in two files fails, keyed by both and counting the lines they share', () => {
    const { code, out } = check(tree({ 'apps/a.ts': sum(14), 'apps/b.ts': sum(14) }))
    expect(code).toBe(1)
    expect(out).toContain(`duplicates  ${key}: 15 lines written in both`)
  })

  test('one under 12 lines passes, and so does one in tests', () => {
    expect(check(tree({ 'apps/a.ts': sum(10), 'apps/b.ts': sum(10) })).code).toBe(0)
    expect(check(tree({ 'apps/a.test.ts': sum(14), 'apps/b.test.ts': sum(14) })).code).toBe(0)
  })

  test('a baselined one passes, fails once it grows, and is stale once folded', () => {
    const entry = (n: number) => ({ duplicates: { [key]: { n, reason: 'two adapters' } } })
    expect(check(tree({ 'apps/a.ts': sum(14), 'apps/b.ts': sum(14) }, entry(15))).code).toBe(0)
    expect(check(tree({ 'apps/a.ts': sum(18), 'apps/b.ts': sum(18) }, entry(15))).out).toContain(
      `duplicates  ${key}: grew from 15 to 19 lines written in both`,
    )
    const folded = { 'apps/a.ts': sum(14), 'apps/b.ts': "export { sum } from './a.ts'\n" }
    expect(check(tree(folded, entry(15))).out).toContain(`duplicates  ${key}: stale baseline entry`)
  })
})

describe('a repository that is one crate', () => {
  test('its src/ is checked against the baseline beside Cargo.toml, without the TypeScript tools', () => {
    const files = {
      'Cargo.toml': '[package]\nname = "k"\n',
      'src/main.rs': '//! The binary.\nmod a;\nmod b;\nmod utils;\nfn main() {}\n',
      'src/a.rs': '//! A.\nuse crate::b;\n',
      'src/b.rs': '//! B.\nuse crate::a;\n',
      'src/utils.rs': '//! Named for a category.\n',
    }
    const dir = tree(files)
    writeFileSync(join(dir, 'structure-baseline.json'), '{}')
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(out).toContain('cycles  src/a.rs ↔ src/b.rs: 2 modules that use each other')
    expect(out).toContain('names  src/utils.rs: is named for a category')
    expect(out).not.toContain('unused')
    const held = { cycles: { 'src/a.rs ↔ src/b.rs': { n: 2, reason: 'one protocol' } } }
    writeFileSync(join(dir, 'structure-baseline.json'), JSON.stringify(held))
    rmSync(join(dir, 'src/utils.rs'))
    expect(check(dir).code).toBe(0)
  })
})
