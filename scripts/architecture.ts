// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Renders the architecture document, docs/architecture/Blockly-Architecture.pdf, from its Typst
 * source in docs/architecture, stamped with the commit, branch and date it was made from.
 *
 *   bun scripts/architecture.ts            the PDF
 *   bun scripts/architecture.ts --pages    and every page as a PNG in the temp dir, to look at
 *
 * Needs Typst 0.15: the `typst` command (brew install typst), or else its Python package
 * (pip install typst==0.15.0). The diagram packages (fletcher, chronos) download on first use.
 * Fonts come from docs/architecture/fonts only, so the PDF is the same on every machine.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const dir = 'docs/architecture'
const source = `${dir}/Blockly-Architecture.typ`
const pdf = `${dir}/Blockly-Architecture.pdf`
const pagesDir = join(tmpdir(), 'blockly-architecture')
const pages = process.argv.includes('--pages')
const say = (line: string) => process.stdout.write(`${line}\n`)

function git(...args: string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString().trim()}`)
  return run.stdout.toString().trim()
}

// What the PDF says it was made from. Uncommitted changes to the source are said too, so a PDF
// can't claim a commit it doesn't match; the PDF itself doesn't count.
const changed = git('status', '--porcelain', '--', dir)
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.endsWith(pdf))
const inputs = {
  commit: git('rev-parse', '--short', 'HEAD') + (changed.length > 0 ? ' + uncommitted changes' : ''),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  date: new Date().toISOString().slice(0, 10),
}

function compile(output: string, format: 'pdf' | 'png'): void {
  const args = ['--root', '.', '--font-path', `${dir}/fonts`, '--ignore-system-fonts']
  for (const [key, value] of Object.entries(inputs)) args.push('--input', `${key}=${value}`)
  const run = Bun.which('typst')
    ? Bun.spawnSync(
        [
          'typst',
          'compile',
          ...args,
          ...(format === 'png' ? ['--format', 'png', '--ppi', '110'] : []),
          source,
          output,
        ],
        { cwd: root, stdout: 'inherit', stderr: 'inherit' },
      )
    : Bun.spawnSync(
        [
          'python3',
          '-c',
          `import json, sys, typst
typst.compile(sys.argv[1], output=sys.argv[2], root='.', font_paths=[sys.argv[3]], ignore_system_fonts=True,
              sys_inputs=json.loads(sys.argv[4]), format=sys.argv[5], ppi=110 if sys.argv[5] == 'png' else None)`,
          source,
          output,
          `${dir}/fonts`,
          JSON.stringify(inputs),
          format,
        ],
        { cwd: root, stdout: 'inherit', stderr: 'inherit' },
      )
  if (run.exitCode !== 0) {
    console.error(`Typst failed. It needs Typst 0.15: brew install typst, or pip install typst==0.15.0`)
    process.exit(1)
  }
}

compile(pdf, 'pdf')
say(`${pdf}: ${inputs.commit} on ${inputs.branch}, ${inputs.date}`)
if (pages) {
  if (existsSync(pagesDir)) rmSync(pagesDir, { recursive: true })
  mkdirSync(pagesDir, { recursive: true })
  compile(`${pagesDir}/page-{0p}.png`, 'png')
  say(`pages: ${pagesDir}/`)
}
