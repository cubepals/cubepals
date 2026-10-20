// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The second reviewer's one comment on a pull request (second-eye.yml): the findings Claude
 * returned as JSON, written in one fixed shape, a verdict and then one line a finding, and edited
 * in place on each run instead of written again.
 *
 *   bun scripts/second-eye-comment.ts
 *
 * It reads REVIEW (the action's structured output), REPO, PULL and GH_TOKEN from the environment
 * the workflow gives it. It needs no installed package. Not for what the reviewer looks for or
 * how it judges: .github/second-eye.md says that.
 */
import { keepComment } from './lib/pull-comment.ts'

export type Severity = 'high' | 'medium' | 'low'

export interface Finding {
  severity: Severity
  file: string
  line: number
  problem: string
  fix: string
}

export interface Review {
  verdict: 'merge' | 'fix first'
  findings: Finding[]
}

/** The comment's first line, which finds it again. */
export const MARKER = '<!-- second-eye -->'
/** At most this many findings are written, most severe first. */
const MOST_FINDINGS = 8

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** Claude's text on one line, with no code spans to break out of and nobody mentioned. */
const plain = (text: unknown): string =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replaceAll('`', "'")
    .replaceAll('@', '@​')
    .trim()

/** The comment's text, in GitHub's Markdown. */
export function secondEyeComment(review: Review): string {
  const findings = (review.findings ?? [])
    .filter((finding) => finding.severity in RANK)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
    .slice(0, MOST_FINDINGS)
  if (findings.length === 0) return `${MARKER}\nVerdict: merge. No findings.`
  const verdict = review.verdict === 'merge' ? 'merge' : 'fix first'
  return [
    MARKER,
    `Verdict: ${verdict}`,
    '',
    ...findings.map(
      (finding) =>
        `- **${finding.severity}** \`${plain(finding.file)}:${Number(finding.line) || 0}\` ${plain(finding.problem)} Fix: ${plain(finding.fix)}`,
    ),
  ].join('\n')
}

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

if (import.meta.main) {
  const review = JSON.parse(need('REVIEW')) as Review
  await keepComment(need('REPO'), need('PULL'), MARKER, secondEyeComment(review))
}
