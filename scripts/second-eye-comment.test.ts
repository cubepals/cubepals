// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The second reviewer's comment: a verdict, then one line a finding, most severe first. */
import { describe, expect, test } from 'bun:test'
import { type Finding, MARKER, secondEyeComment } from './second-eye-comment.ts'

const finding = (severity: Finding['severity'], line: number): Finding => ({
  severity,
  file: 'apps/control/src/billing.ts',
  line,
  problem: 'Hours are charged twice when the stop retries.',
  fix: 'Charge once, keyed by the stop.',
})

describe('secondEyeComment', () => {
  test('nothing found reads as merge with no findings', () => {
    expect(secondEyeComment({ verdict: 'merge', findings: [] })).toBe(
      `${MARKER}\nVerdict: merge. No findings.`,
    )
  })

  test('a verdict, then each finding on one line, most severe first', () => {
    const body = secondEyeComment({
      verdict: 'fix first',
      findings: [finding('low', 3), finding('high', 1), finding('medium', 2)],
    })
    const lines = body.split('\n')
    expect(lines.slice(0, 2)).toEqual([MARKER, 'Verdict: fix first'])
    expect(lines.slice(3)).toEqual([
      '- **high** `apps/control/src/billing.ts:1` Hours are charged twice when the stop retries. Fix: Charge once, keyed by the stop.',
      '- **medium** `apps/control/src/billing.ts:2` Hours are charged twice when the stop retries. Fix: Charge once, keyed by the stop.',
      '- **low** `apps/control/src/billing.ts:3` Hours are charged twice when the stop retries. Fix: Charge once, keyed by the stop.',
    ])
  })

  test('at most eight findings, under twenty lines', () => {
    const body = secondEyeComment({
      verdict: 'fix first',
      findings: Array.from({ length: 12 }, (_, i) => finding('medium', i + 1)),
    })
    expect(body.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(8)
    expect(body.split('\n').length).toBeLessThan(20)
  })

  test('keeps each finding to one line, and mentions nobody', () => {
    const body = secondEyeComment({
      verdict: 'fix first',
      findings: [{ ...finding('high', 1), problem: 'Breaks\nfor `x`', fix: 'Ask @someone' }],
    })
    const line = body.split('\n')[3]
    expect(line).toContain("Breaks for 'x'")
    expect(line).not.toContain('@someone')
    expect(body.split('\n')).toHaveLength(4)
  })

  test('drops a severity outside high, medium and low', () => {
    const odd = { ...finding('high', 1), severity: 'critical' } as unknown as Finding
    expect(secondEyeComment({ verdict: 'fix first', findings: [odd] })).toBe(
      `${MARKER}\nVerdict: merge. No findings.`,
    )
  })
})
