// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'check-move-only.ts')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]) {
  const run = Bun.spawnSync(['git', ...args], { cwd: dir, stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
}

function write(dir: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(dir, path))
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'change')
}

/** A repository whose first commit holds `before` and whose second applies `after`. */
function repo(before: Record<string, string>, after: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'move-only-'))
  made.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  write(dir, before)
  write(dir, after)
  return dir
}

function check(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  const run = Bun.spawnSync(['bun', SCRIPT, '--base', 'HEAD^', '--head', 'HEAD', ...args], {
    cwd: dir,
    env: { ...process.env, PR_BODY: '', ...env },
    stderr: 'pipe',
  })
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() }
}

/** The lines printed under `heading`, up to the next blank line. */
function section(out: string, heading: string): string[] {
  const lines = out.split('\n')
  const start = lines.findIndex((line) => line.startsWith(heading))
  if (start === -1) return []
  const end = lines.findIndex((line, i) => i > start && line.trim() === '')
  return lines.slice(start + 1, end === -1 ? undefined : end).map((line) => line.trim())
}

const TS_BEFORE = `import { clamp } from './math.ts'

export function first(xs: number[]): number {
  return clamp(xs[0] ?? 0)
}

export function total(xs: number[]): number {
  let sum = 0
  for (const x of xs) {
    if (x < 100) sum += x
  }
  return sum
}

export function largest(xs: number[]): number {
  return Math.max(...xs)
}
`

const TS_MOVED = `/** Sums and extremes of a list of counts. */
import { clamp } from './math.ts'

export function total(xs: number[]): number {
  let sum = 0
  for (const x of xs) {
    if (x < 100) sum += x
  }
  return clamp(sum)
}
`

const RUST_BEFORE = `//! The manager.

use std::collections::HashMap;

pub struct Manager {
    ports: HashMap<u16, String>,
}

impl Manager {
    pub fn new() -> Self {
        Self { ports: HashMap::new() }
    }

    fn free_port(&self) -> u16 {
        let mut port = 25565;
        while self.ports.contains_key(&port) {
            port += 1;
        }
        port
    }

    pub fn claim(&mut self, name: &str) -> u16 {
        let port = self.free_port();
        self.ports.insert(port, name.to_string());
        port
    }
}
`

const RUST_MANAGER_AFTER = `//! The manager.
//!
//! Ports live in \`ports.rs\`.

use std::collections::HashMap;

mod ports;

pub struct Manager {
    ports: HashMap<u16, String>,
}

impl Manager {
    pub fn new() -> Self {
        Self { ports: HashMap::new() }
    }

    pub fn claim(&mut self, name: &str) -> u16 {
        let port = self.free_port();
        self.ports.insert(port, name.to_string());
        port
    }
}
`

/** The manager's ports module, with `body` as free_port's loop. */
const rustPorts = (signature: string, body: string) => `//! Ports the manager hands out.

use super::*;

impl Manager {
    ${signature}
        let mut port = 25565;
${body}
        port
    }
}
`

const LOOP = `        while self.ports.contains_key(&port) {
            port += 1;
        }`

describe('a move passes', () => {
  test('functions moved into a new file with a header and imports', () => {
    const dir = repo(
      { 'apps/web/src/counts.ts': TS_BEFORE.replace('return sum', 'return clamp(sum)') },
      {
        'apps/web/src/counts.ts': `import { clamp } from './math.ts'
export { total } from './counts/sums.ts'

export function first(xs: number[]): number {
  return clamp(xs[0] ?? 0)
}

export function largest(xs: number[]): number {
  return Math.max(...xs)
}
`,
        'apps/web/src/counts/sums.ts': TS_MOVED,
      },
    )
    const { code, out } = check(dir)
    expect(out).toContain('ok')
    expect(code).toBe(0)
  })

  test('a Rust move into a child module lists its pub(super)', () => {
    const dir = repo(
      { 'apps/blocklyd/src/manager.rs': RUST_BEFORE },
      {
        'apps/blocklyd/src/manager.rs': RUST_MANAGER_AFTER,
        'apps/blocklyd/src/manager/ports.rs': rustPorts('pub(super) fn free_port(&self) -> u16 {', LOOP),
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(0)
    expect(section(out, 'Made visible to siblings')).toEqual([
      'apps/blocklyd/src/manager/ports.rs:6: pub(super) fn free_port(&self) -> u16 {',
    ])
  })

  test('a TypeScript move where the old path re-exports lists the export', () => {
    const dir = repo(
      {
        'apps/control/src/infra/fleet/registry.ts': `import { createHash } from 'node:crypto'

function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function register(key: string): { id: string } {
  return { id: fingerprint(key) }
}
`,
      },
      {
        'apps/control/src/infra/fleet/registry.ts': `export { register } from './registry/register.ts'
`,
        'apps/control/src/infra/fleet/registry/register.ts': `/** Registering a node. */
import { fingerprint } from './fingerprint.ts'

export function register(key: string): { id: string } {
  return { id: fingerprint(key) }
}
`,
        'apps/control/src/infra/fleet/registry/fingerprint.ts': `import { createHash } from 'node:crypto'

export function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
`,
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(0)
    expect(section(out, 'Made visible to siblings')).toEqual([
      'apps/control/src/infra/fleet/registry/fingerprint.ts:3: export function fingerprint(key: string): string {',
    ])
  })

  test('a line reordered inside a moved function passes: lines are a multiset', () => {
    const dir = repo(
      { 'apps/blocklyd/src/manager.rs': RUST_BEFORE },
      {
        'apps/blocklyd/src/manager.rs': RUST_MANAGER_AFTER,
        'apps/blocklyd/src/manager/ports.rs': rustPorts(
          'pub(super) fn free_port(&self) -> u16 {',
          `        while self.ports.contains_key(&port) {
        }
            port += 1;`,
        ),
      },
    )
    expect(check(dir).code).toBe(0)
  })

  test('a line the formatter re-wrapped passes as re-wrapped', () => {
    const dir = repo(
      {
        'apps/blocklyd/src/manager.rs': `impl Manager {
    fn reserve_port_for_workload(&self, workload: WorkloadId, wanted: u16) -> Result<u16, Error> {
        self.ports.reserve(workload, wanted)
    }

    fn other(&self) {}
}
`,
      },
      {
        'apps/blocklyd/src/manager.rs': `mod ports;

impl Manager {
    fn other(&self) {}
}
`,
        'apps/blocklyd/src/manager/ports.rs': `use super::*;

impl Manager {
    pub(super) fn reserve_port_for_workload(
        &self,
        workload: WorkloadId,
        wanted: u16,
    ) -> Result<u16, Error> {
        self.ports.reserve(workload, wanted)
    }
}
`,
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(0)
    expect(section(out, 'Re-wrapped')).toContain('apps/blocklyd/src/manager/ports.rs:5: &self,')
    expect(section(out, 'Made visible to siblings')).toEqual([
      'apps/blocklyd/src/manager/ports.rs:4: pub(super) fn reserve_port_for_workload(',
    ])
  })

  test('a line of closing brackets is boilerplate: a split array adds one per piece', () => {
    const dir = repo(
      {
        'apps/web/src/routes.ts': `export const ROUTES = [
  { path: '/a', page: () => ({ title: 'A' }) },
  { path: '/b', page: () => ({ title: 'B' }) },
]
`,
      },
      {
        'apps/web/src/routes.ts': `import { MORE } from './routes/more.ts'

export const ROUTES = [
  { path: '/a', page: () => ({ title: 'A' }) },
  ...MORE,
]
`,
        'apps/web/src/routes/more.ts': `export const MORE = [
  { path: '/b', page: () => ({ title: 'B' }) },
]
`,
      },
    )
    const body = '## Not a move\n\n```\n...MORE,\nexport const MORE = [\n```\n'
    const { code, out } = check(dir, [], { PR_BODY: body })
    expect(code).toBe(0)
    expect(out).toContain('2 module boilerplate')
  })

  test('a re-export the formatter wraps is boilerplate, every line of it', () => {
    const dir = repo(
      {
        'apps/control/src/infra/fleet/registry.ts': `export type DrainReason = 'operator' | 'maintenance'
export type RetireReason = 'lost' | 'replaced'

export function drainNodeForMaintenance(id: string): string {
  return \`drain \${id}\`
}

export function reinstateNodeAfterMaintenance(id: string): string {
  return \`reinstate \${id}\`
}

export function retireNodePermanently(id: string): string {
  return \`retire \${id}\`
}
`,
      },
      {
        'apps/control/src/infra/fleet/registry.ts': `export type {
  DrainReason,
  RetireReason,
} from './registry/lifecycle-reasons-for-operators-and-the-fleet-runtime.ts'
export {
  drainNodeForMaintenance,
  reinstateNodeAfterMaintenance,
  retireNodePermanently,
} from './registry/lifecycle.ts'
`,
        'apps/control/src/infra/fleet/registry/lifecycle-reasons-for-operators-and-the-fleet-runtime.ts': `export type DrainReason = 'operator' | 'maintenance'
export type RetireReason = 'lost' | 'replaced'
`,
        'apps/control/src/infra/fleet/registry/lifecycle.ts': `export function drainNodeForMaintenance(id: string): string {
  return \`drain \${id}\`
}

export function reinstateNodeAfterMaintenance(id: string): string {
  return \`reinstate \${id}\`
}

export function retireNodePermanently(id: string): string {
  return \`retire \${id}\`
}
`,
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(0)
    expect(out).toContain('9 module boilerplate')
  })

  test('lockfiles, generated code, migrations and fixtures are skipped', () => {
    const dir = repo(
      { 'apps/web/src/a.ts': 'export const a = 1\n' },
      {
        'bun.lock': '{}\n',
        'apps/control/src/infra/fly/generated/fly.ts': 'export type X = 1\n',
        'packages/db/migrations/0001.sql': 'select 1;\n',
        'apps/control/src/fixtures/node.ts': 'export const node = {}\n',
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(0)
    expect(out).toContain('4 files skipped')
  })
})

describe('anything but a move fails', () => {
  const moveWith = (signature: string, body: string) =>
    repo(
      { 'apps/blocklyd/src/manager.rs': RUST_BEFORE },
      {
        'apps/blocklyd/src/manager.rs': RUST_MANAGER_AFTER,
        'apps/blocklyd/src/manager/ports.rs': rustPorts(signature, body),
      },
    )

  test('one changed token inside a moved function, naming the line', () => {
    const dir = moveWith('pub(super) fn free_port(&self) -> u16 {', LOOP.replace('port += 1', 'port += 2'))
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Added, not moved')).toEqual(['apps/blocklyd/src/manager/ports.rs:9: port += 2;'])
    expect(section(out, 'Removed, not moved')).toEqual(['apps/blocklyd/src/manager.rs:17: port += 1;'])
  })

  test('a < turned into <=', () => {
    const dir = repo(
      { 'apps/web/src/counts.ts': TS_BEFORE.replace('return sum', 'return clamp(sum)') },
      {
        'apps/web/src/counts.ts': TS_BEFORE.replace(/\nexport function total[\s\S]*?\n}\n/, ''),
        'apps/web/src/counts/sums.ts': TS_MOVED.replace('x < 100', 'x <= 100'),
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Added, not moved')).toEqual([
      'apps/web/src/counts/sums.ts:7: if (x <= 100) sum += x',
    ])
  })

  test('a moved function with a line deleted', () => {
    const dir = moveWith(
      'pub(super) fn free_port(&self) -> u16 {',
      LOOP.replace('            port += 1;\n', ''),
    )
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Removed, not moved')).toEqual(['apps/blocklyd/src/manager.rs:17: port += 1;'])
  })

  test('a new function that was not there before', () => {
    const dir = repo(
      { 'apps/web/src/counts.ts': TS_BEFORE },
      {
        'apps/web/src/counts.ts': `${TS_BEFORE}\nexport function smallest(xs: number[]): number {\n  return 0\n}\n`,
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Added, not moved')).toEqual([
      'apps/web/src/counts.ts:19: export function smallest(xs: number[]): number {',
      'apps/web/src/counts.ts:20: return 0',
    ])
  })

  test('a moved function renamed', () => {
    const dir = moveWith('pub(super) fn next_free_port(&self) -> u16 {', LOOP)
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(out).toContain(
      'apps/blocklyd/src/manager/ports.rs:6: pub(super) fn next_free_port(&self) -> u16 {',
    )
  })

  test('pub(crate) added to a moved line', () => {
    const dir = moveWith('pub(crate) fn free_port(&self) -> u16 {', LOOP)
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Added, not moved')).toEqual([
      'apps/blocklyd/src/manager/ports.rs:6: pub(crate) fn free_port(&self) -> u16 {',
    ])
  })

  test('pub added to a moved line', () => {
    const dir = moveWith('pub fn free_port(&self) -> u16 {', LOOP)
    expect(check(dir).code).toBe(1)
  })

  test('export default added to a moved line', () => {
    const dir = repo(
      { 'apps/web/src/counts.ts': TS_BEFORE.replace('export function first', 'function first') },
      {
        'apps/web/src/counts.ts': TS_BEFORE.replace(/export function first[\s\S]*?\n}\n\n/, ''),
        'apps/web/src/first.ts': `import { clamp } from './math.ts'

export default function first(xs: number[]): number {
  return clamp(xs[0] ?? 0)
}
`,
      },
    )
    expect(check(dir).code).toBe(1)
  })

  test('a comment added in the middle of a file', () => {
    const dir = repo(
      { 'apps/web/src/counts.ts': TS_BEFORE.replace('return sum', 'return clamp(sum)') },
      {
        'apps/web/src/counts.ts': TS_BEFORE.replace(/\nexport function total[\s\S]*?\n}\n/, ''),
        'apps/web/src/counts/sums.ts': TS_MOVED.replace(
          '  let sum = 0\n',
          '  let sum = 0\n  /** Running total. */\n',
        ),
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Added, not moved')).toEqual(['apps/web/src/counts/sums.ts:6: /** Running total. */'])
  })

  test('a wrapped export of local names, with no from, is not boilerplate', () => {
    const before = `function drainNodeForMaintenance(id: string): string {
  return \`drain \${id}\`
}

function reinstateNodeAfterMaintenance(id: string): string {
  return \`reinstate \${id}\`
}

function retireNodePermanently(id: string): string {
  return \`retire \${id}\`
}
`
    const dir = repo(
      { 'apps/control/src/infra/fleet/registry.ts': before },
      {
        'apps/control/src/infra/fleet/registry.ts': `${before}
export {
  drainNodeForMaintenance,
  reinstateNodeAfterMaintenance,
  retireNodePermanently,
}
`,
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Added, not moved')).toEqual([
      'apps/control/src/infra/fleet/registry.ts:13: export {',
      'apps/control/src/infra/fleet/registry.ts:14: drainNodeForMaintenance,',
      'apps/control/src/infra/fleet/registry.ts:15: reinstateNodeAfterMaintenance,',
      'apps/control/src/infra/fleet/registry.ts:16: retireNodePermanently,',
    ])
  })

  test('a file outside apps/, packages/ and scripts/', () => {
    const dir = repo(
      { 'apps/blocklyd/src/manager.rs': RUST_BEFORE, 'docs/fleet.md': '# Fleet\n' },
      {
        'apps/blocklyd/src/manager.rs': RUST_MANAGER_AFTER,
        'apps/blocklyd/src/manager/ports.rs': rustPorts('pub(super) fn free_port(&self) -> u16 {', LOOP),
        'docs/fleet.md': '# Fleet\n\nPorts moved.\n',
      },
    )
    const { code, out } = check(dir)
    expect(code).toBe(1)
    expect(section(out, 'Changed outside')).toEqual(['docs/fleet.md'])
  })
})

// A split file's baseline entry goes stale (scripts/check-structure.ts), so a move may drop it, or
// lower a number, and nothing else.
describe('the structure baseline', () => {
  const baseline = (
    entries: Record<string, { n: number; reason: string }>,
    files = ['apps/control/src/a.ts'],
  ) => `${JSON.stringify({ size: entries, headers: { reason: 'No header yet.', files } }, null, 2)}\n`
  const big = { 'apps/control/src/stats.ts': { n: 900, reason: 'One job, not yet split.' } }
  const other = { 'apps/control/src/other.ts': { n: 850, reason: 'Not looked at yet.' } }
  const moved = (after: string) =>
    repo(
      {
        'apps/control/src/stats.ts': TS_BEFORE,
        'scripts/structure-baseline.json': baseline({ ...big, ...other }),
      },
      {
        'apps/control/src/stats.ts': TS_BEFORE.replace(/\nexport function total[\s\S]*?\n}\n/, ''),
        'apps/control/src/stats/total.ts': `/** The sum of a list of counts. */\n${TS_BEFORE.match(/export function total[\s\S]*?\n}\n/)?.[0]}`,
        'scripts/structure-baseline.json': after,
      },
    )

  test('may lose the entry of the file the move split, and lower another', () => {
    expect(check(moved(baseline({ ...big, ...other }, []))).code).toBe(0)
    const { code, out } = check(
      moved(baseline({ 'apps/control/src/other.ts': { n: 800, reason: 'Not looked at yet.' } })),
    )
    expect(out).toContain('ok   only moved')
    expect(code).toBe(0)
    expect(section(out, 'Baseline shrunk')).toEqual(['scripts/structure-baseline.json'])
  })

  test('may not gain an entry or a listed file, raise a number or change a reason', () => {
    for (const [after, said] of [
      [
        baseline({ ...big, ...other, 'apps/control/src/new.ts': { n: 801, reason: 'x' } }),
        'adds size apps/control/src/new.ts',
      ],
      [
        baseline({ ...big, 'apps/control/src/other.ts': { n: 851, reason: 'Not looked at yet.' } }),
        'raises size apps/control/src/other.ts',
      ],
      [
        baseline({ ...big, 'apps/control/src/other.ts': { n: 850, reason: 'Fine as it is.' } }),
        'changes the reason for size apps/control/src/other.ts',
      ],
      [
        baseline({ ...big, ...other }, ['apps/control/src/a.ts', 'apps/control/src/b.ts']),
        'adds headers apps/control/src/b.ts',
      ],
    ] as const) {
      const { code, out } = check(moved(after))
      expect(code).toBe(1)
      expect(section(out, 'Changed outside')).toEqual([`scripts/structure-baseline.json: ${said}`])
    }
  })
})

describe('declared exceptions', () => {
  const before = {
    'scripts/economics/catalog.ts': `export const OFFERS = [
  { name: 'fly', price: 1 },
  { name: 'boat', price: 2 },
]
`,
  }
  const after = {
    'scripts/economics/catalog.ts': `import { BOAT } from './catalog/boat.ts'
import { FLY } from './catalog/fly.ts'

export const OFFERS = [...FLY, ...BOAT]
`,
    'scripts/economics/catalog/fly.ts': `export const FLY = [
  { name: 'fly', price: 1 },
]
`,
    'scripts/economics/catalog/boat.ts': `export const BOAT = [
  { name: 'boat', price: 2 },
]
`,
  }
  const declared = [
    'export const OFFERS = [',
    'export const OFFERS = [...FLY, ...BOAT]',
    'export const FLY = [',
    'export const BOAT = [',
  ]

  test('lines declared in the PR body pass and are printed', () => {
    const body = `Splits the catalog.\n\n## Not a move\n\n\`\`\`ts\n${declared.join('\n')}\n\`\`\`\n`
    const { code, out } = check(repo(before, after), [], { PR_BODY: body })
    expect(code).toBe(0)
    expect(section(out, 'Declared')).toContain(
      'scripts/economics/catalog.ts:4: export const OFFERS = [...FLY, ...BOAT]',
    )
  })

  test('lines declared in a file given to --allow pass', () => {
    const dir = repo(before, after)
    writeFileSync(join(dir, 'allow.txt'), `${declared.join('\n')}\n`)
    expect(check(dir, ['--allow', join(dir, 'allow.txt')]).code).toBe(0)
  })

  test('an undeclared copy of a declared line fails', () => {
    expect(check(repo(before, after)).code).toBe(1)
    const twice = repo(before, {
      ...after,
      'scripts/economics/catalog/fly.ts': `export const FLY = [\n  { name: 'fly', price: 1 },\n]\nexport const FLY = [\n]\n`,
    })
    const body = `## Not a move\n\n\`\`\`\n${declared.join('\n')}\n\`\`\`\n`
    const { code, out } = check(twice, [], { PR_BODY: body })
    expect(code).toBe(1)
    expect(section(out, 'Added, not moved')).toContain(
      'scripts/economics/catalog/fly.ts:4: export const FLY = [',
    )
  })

  test('40 declared lines pass, and more than 40 fails', () => {
    const body = (count: number) => {
      const lines = [
        ...declared,
        ...Array.from({ length: count - declared.length }, (_, i) => `const x${i} = ${i}`),
      ]
      return `## Not a move\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`
    }
    expect(check(repo(before, after), [], { PR_BODY: body(40) }).code).toBe(0)
    const { code, out } = check(repo(before, after), [], { PR_BODY: body(41) })
    expect(code).toBe(1)
    expect(out).toContain('41 lines declared')
  })
})
