// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lint rule that keeps every public page on one reading of the plans (`plan-figures.grit`):
 * a read of the plan table or the offer anywhere in the site but `lib/plans.ts` fails, however the
 * address is written, and the same words elsewhere don't.
 */
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../../..')
const RULE = 'apps/web/plan-figures.grit'
const PLUGINS = (
  JSON.parse(readFileSync(join(ROOT, 'biome.json'), 'utf8')) as { plugins: { path: string }[] }
).plugins.map((plugin) => plugin.path.replace(/^\.\//, ''))
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** Where the rule points in a git checkout holding `files` and the repository's lint setup. */
function flagged(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'plan-figures-'))
  made.push(dir)
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  const setup = ['biome.json', ...PLUGINS].map((path): [string, string] => [
    path,
    readFileSync(join(ROOT, path), 'utf8'),
  ])
  for (const [path, content] of [...setup, ...Object.entries(files)]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const run = Bun.spawnSync(
    [join(ROOT, 'node_modules/.bin/biome'), 'lint', '--reporter=json', '--max-diagnostics=none', '.'],
    { cwd: dir, stderr: 'pipe' },
  )
  type Diagnostic = { category: string; message: string; location: { path: string; start: { line: number } } }
  return (JSON.parse(run.stdout.toString()).diagnostics as Diagnostic[])
    .filter((d) => d.category === 'plugin' && d.message.includes('pricedPlans'))
    .map((d) => `${d.location.path}:${d.location.start.line}`)
}

test('a page that reads the plan table or the offer itself fails, and lib/plans.ts doesn’t', () => {
  expect(PLUGINS).toContain(RULE)
  const reads = [
    "export const table = () => fetch('http://control/api/public/plans')",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source of a page, for the rule to read.
    'export const offer = (origin: string) => fetch(`${origin}/api/public/offer`)',
    "export const sizes = () => fetch('http://control/api/public/sizes')",
  ].join('\n')
  expect(
    flagged({
      'apps/web/src/app/(public)/page.tsx': reads,
      'apps/web/src/lib/plans.ts': reads,
      'apps/web/src/lib/plans.test.ts': reads,
      'scripts/elsewhere.ts': reads,
    }).sort(),
  ).toEqual(['apps/web/src/app/(public)/page.tsx:1', 'apps/web/src/app/(public)/page.tsx:2'])
})
