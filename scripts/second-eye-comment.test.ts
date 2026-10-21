// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The second reviewer's comment: an AI review's heading, verdict, run, findings and footer. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  type Finding,
  LABELS,
  labelFor,
  lookedAt,
  MARKER,
  type Run,
  secondEyeComment,
} from './second-eye-comment.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'

const run: Run = {
  repo: 'cubepals/cubepals',
  pull: 42,
  sha: SHA,
  files: 3,
  additions: 120,
  deletions: 14,
  model: 'claude-test-model',
  runUrl: 'https://github.com/cubepals/cubepals/actions/runs/7',
  areas: ['bugs', 'security'],
  updating: false,
}

const finding = (severity: Finding['severity'], line: number): Finding => ({
  severity,
  file: 'apps/control/src/billing.ts',
  line,
  problem: 'Hours are charged twice when the stop retries.',
  fix: 'Charge once, keyed by the stop.',
  why: 'The retry calls charge() again.',
})

const findingRows = (body: string) => body.split('\n').filter((line) => /^\| (🔴|🟠|🟡)&nbsp;/.test(line))

describe('secondEyeComment', () => {
  test('nothing found reads as an AI review that says merge', () => {
    const body = secondEyeComment({ verdict: 'merge', findings: [] }, run)
    const lines = body.split('\n')
    expect(lines[0]).toBe(MARKER)
    expect(lines[1]).toBe('### 🤖 Second eye · AI review by Claude')
    expect(lines[3]).toBe('✅ **Verdict: Merge.** No findings.')
    expect(body).toContain(
      `| **Reviewed** | [\`0123456\`](https://github.com/cubepals/cubepals/commit/${SHA}) · 3 files, +120 −14 lines |`,
    )
    expect(body).toContain('| Run | Details |\n| :--- | :--- |\n| **Reviewed** |')
    expect(body).not.toContain('| | |')
    expect(body).toContain('| **Looked at** | Bugs, security |')
    expect(body).toContain(
      '| **Model** | `claude-test-model` · [Workflow run](https://github.com/cubepals/cubepals/actions/runs/7) |',
    )
    expect(body).not.toContain('<details>')
    expect(lines.at(-1)).toBe(
      "<sub>An automated review by Claude, not a person. It advises and doesn't block the merge. Re-run: `gh workflow run second-eye.yml -f pr=42`</sub>",
    )
  })

  test('findings: a row each, most severe first, linked to the line, reasons folded', () => {
    const body = secondEyeComment(
      { verdict: 'fix first', findings: [finding('low', 3), finding('high', 1), finding('medium', 2)] },
      run,
    )
    expect(body).toContain('⚠️ **Verdict: Fix first.** 3 findings.')
    const link = (line: number) =>
      `[\`apps/control/src/billing.ts:${line}\`](https://github.com/cubepals/cubepals/blob/${SHA}/apps/control/src/billing.ts#L${line})`
    expect(findingRows(body)).toEqual([
      `| 🔴&nbsp;High | ${link(1)} | Hours are charged twice when the stop retries. |`,
      `| 🟠&nbsp;Medium | ${link(2)} | Hours are charged twice when the stop retries. |`,
      `| 🟡&nbsp;Low | ${link(3)} | Hours are charged twice when the stop retries. |`,
    ])
    const details = body.slice(body.indexOf('<details>'), body.indexOf('</details>'))
    expect(details).toContain(
      `1. ${link(1)} The retry calls charge() again. **Fix:** Charge once, keyed by the stop.`,
    )
  })

  test('at most eight findings', () => {
    const body = secondEyeComment(
      { verdict: 'fix first', findings: Array.from({ length: 12 }, (_, i) => finding('medium', i + 1)) },
      run,
    )
    expect(findingRows(body)).toHaveLength(8)
    expect(body).toContain('8 findings.')
  })

  test("Claude's text stays in its cell, opens no tag, and mentions nobody", () => {
    const body = secondEyeComment(
      {
        verdict: 'fix first',
        findings: [{ ...finding('high', 1), problem: 'Breaks\nfor `x` | <img src=y>', fix: 'Ask @someone' }],
      },
      run,
    )
    const [row] = findingRows(body)
    expect(row).toContain("Breaks for 'x' \\| &lt;img src=y>")
    expect(body).not.toContain('<img')
    expect(body).not.toContain('@someone')
  })

  test('drops a severity outside high, medium and low', () => {
    const odd = { ...finding('high', 1), severity: 'critical' } as unknown as Finding
    expect(secondEyeComment({ verdict: 'fix first', findings: [odd] }, run)).toBe(
      secondEyeComment({ verdict: 'merge', findings: [] }, run),
    )
  })

  test('an edit of an earlier comment says which commit it is for, under the marker', () => {
    const lines = secondEyeComment({ verdict: 'merge', findings: [] }, { ...run, updating: true }).split('\n')
    expect(lines[0]).toBe(MARKER)
    expect(lines[1]).toBe(
      `<sub>Updated for [\`0123456\`](https://github.com/cubepals/cubepals/commit/${SHA})</sub>`,
    )
    expect(lines[3]).toBe('### 🤖 Second eye · AI review by Claude')
  })
})

describe('labelFor', () => {
  test('one label for the verdict', () => {
    expect(labelFor({ verdict: 'merge', findings: [] })).toBe(LABELS.merge)
    expect(labelFor({ verdict: 'fix first', findings: [finding('high', 1)] })).toBe(LABELS['fix first'])
    expect(labelFor({ verdict: 'merge', findings: [finding('low', 1)] })).toBe(LABELS.merge)
  })

  test('fix first with nothing to fix is merge', () => {
    expect(labelFor({ verdict: 'fix first', findings: [] })).toBe(LABELS.merge)
  })
})

describe('lookedAt', () => {
  test("names what .github/second-eye.md's rules count", () => {
    const rules = readFileSync(new URL('../.github/second-eye.md', import.meta.url), 'utf8')
    expect(lookedAt(rules)).toEqual([
      'bugs',
      'security',
      'data or money mistakes',
      'broken rules from `CLAUDE.md` and `AGENTS.md`',
    ])
  })
})
