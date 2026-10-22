// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The second eye's gate (second-eye.yml): the one status, "Second eye gate", that a ruleset can
 * require, and the two decisions behind it: which pull requests the review starts on by itself,
 * and what the status says.
 *
 * A pull request that touches none of the sensitive paths passes at once. One that does fails
 * until v0id-user has asked for the review (the needs-second-eye label, an "@claude review"
 * line, or a run by hand) and it has finished, so it can't merge without that. The review starts
 * by itself only on a same-repository pull request that v0id-user opened and that touches a
 * sensitive path; anyone else's never spends the subscription unasked.
 *
 *   MODE=paths  bun scripts/second-eye-gate.ts   writes `sensitive` and `auto` to GITHUB_OUTPUT
 *   MODE=status bun scripts/second-eye-gate.ts   sets the status on the pull request's head
 *
 * It needs no installed package. Not for what the reviewer looks for: .github/second-eye.md.
 */
import { appendFileSync } from 'node:fs'
import { github } from './lib/pull-comment.ts'

/** The status a ruleset requires. */
export const CONTEXT = 'Second eye gate'
/** The one account whose request, or whose own pull request, starts a review. */
export const MAINTAINER = 'v0id-user'

/** Paths whose change needs a second eye: workflows and the second eye's own prompt and scripts, infrastructure, images, dependencies, the schema, production and staging tooling, the edge, and the control plane's money and access code. */
const SENSITIVE: RegExp[] = [
  /^\.github\/workflows\//,
  /^\.github\/second-eye\.md$/,
  /^scripts\/second-eye/,
  /^infra\//,
  /(^|\/)(Dockerfile(\..*)?|.*\.Dockerfile)$/,
  /(^|\/)(package\.json|bun\.lock)$/,
  /^packages\/db\//,
  /^scripts\/(production|staging|ops)/,
  /^apps\/edge\//,
  /^apps\/control\/src\/(app|domain|infra|interfaces)\/(billing|access|auth|wake|joins|edge)\//,
  /^apps\/control\/src\/infra\/polar\//,
  /^apps\/control\/src\/.*wake[^/]*$/,
]

export const isSensitive = (path: string): boolean => SENSITIVE.some((pattern) => pattern.test(path))

/** The pull request event the review may start on by itself. */
export interface Start {
  event: string
  action: string
  actor: string
  triggeringActor: string
  author: string
  sameRepo: boolean
  sensitive: boolean
}

/** True when the review starts without anyone asking: v0id-user's own pull request, in this repository. */
export const startsByItself = (start: Start): boolean =>
  start.event === 'pull_request' &&
  ['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(start.action) &&
  start.sameRepo &&
  start.sensitive &&
  start.author === MAINTAINER &&
  start.actor === MAINTAINER &&
  start.triggeringActor === MAINTAINER

export interface Outcome {
  event: string
  /** 'true' or 'false' from the paths step; '' when it didn't run or failed. */
  sensitive: string
  /** The results of the workflow's jobs. */
  mark: string
  review: string
  comment: string
}

/** What the status says, or nothing when this run has nothing to add. */
export function statusFor(
  outcome: Outcome,
): { state: 'success' | 'failure'; description: string } | undefined {
  const reviewed = outcome.review === 'success' && outcome.comment === 'success'
  if (reviewed) return { state: 'success', description: 'Reviewed by the second eye.' }
  // A comment or a run by hand only ever adds a review; it has nothing to take back.
  if (outcome.event === 'issue_comment' || outcome.event === 'workflow_dispatch') return undefined
  if (outcome.sensitive === 'false')
    return { state: 'success', description: 'Touches no path that needs a second eye.' }
  if (outcome.sensitive !== 'true')
    return {
      state: 'failure',
      description: "Couldn't tell whether this touches a path that needs a second eye.",
    }
  if (outcome.mark === 'success' && outcome.review === 'skipped')
    return { state: 'failure', description: 'Waits for the pull request to be ready for review.' }
  if (outcome.mark === 'success')
    return { state: 'failure', description: "The second eye didn't finish. v0id-user can request it again." }
  return {
    state: 'failure',
    description: `Touches a path that needs a second eye. Waits for ${MAINTAINER} to request it.`,
  }
}

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** Every path the pull request changes, renames' old names included. */
async function changedPaths(repo: string, pull: string): Promise<{ paths: string[]; complete: boolean }> {
  const paths: string[] = []
  for (let page = 1; page <= 30; page++) {
    const response = await github(`repos/${repo}/pulls/${pull}/files?per_page=100&page=${page}`)
    const files = (await response.json()) as { filename: string; previous_filename?: string }[]
    for (const file of files)
      paths.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []))
    if (files.length < 100) return { paths, complete: true }
  }
  // GitHub lists at most 3000 files; past that, assume the worst.
  return { paths, complete: false }
}

async function writePaths(repo: string, pull: string): Promise<void> {
  const { paths, complete } = await changedPaths(repo, pull)
  const sensitive = !complete || paths.some(isSensitive)
  const auto = startsByItself({
    event: need('EVENT'),
    action: process.env.ACTION ?? '',
    actor: need('ACTOR'),
    triggeringActor: need('TRIGGERING_ACTOR'),
    author: need('AUTHOR'),
    sameRepo: process.env.SAME_REPO === 'true',
    sensitive,
  })
  appendFileSync(need('GITHUB_OUTPUT'), `sensitive=${sensitive}\nauto=${auto}\n`)
}

async function writeStatus(repo: string): Promise<void> {
  const state = statusFor({
    event: need('EVENT'),
    sensitive: process.env.SENSITIVE ?? '',
    mark: process.env.MARK ?? '',
    review: process.env.REVIEW ?? '',
    comment: process.env.COMMENT ?? '',
  })
  const sha = process.env.SHA ?? ''
  if (!state || !/^[0-9a-f]{40}$/.test(sha)) return
  if (state.state === 'failure') {
    // A review that already passed on this commit stands: an event that asks for none (a label
    // that isn't the review's, a reopening) must not take it back.
    const now = await github(`repos/${repo}/commits/${sha}/status`)
    const statuses = ((await now.json()) as { statuses: { context: string; state: string }[] }).statuses
    if (statuses.some((s) => s.context === CONTEXT && s.state === 'success')) return
  }
  await github(`repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({
      state: state.state,
      context: CONTEXT,
      description: state.description,
      target_url: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${need('GITHUB_RUN_ID')}`,
    }),
  })
}

if (import.meta.main) {
  if (process.env.MODE === 'paths') await writePaths(need('REPO'), need('PULL'))
  else if (process.env.MODE === 'status') await writeStatus(need('REPO'))
  else throw new Error(`MODE is ${process.env.MODE}`)
}
