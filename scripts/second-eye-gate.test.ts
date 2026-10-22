// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The second eye's gate: which paths need it, who starts it, and what the status says. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  isSensitive,
  MAINTAINER,
  type Outcome,
  type Start,
  startsByItself,
  statusFor,
} from './second-eye-gate.ts'

describe('isSensitive', () => {
  test.each([
    '.github/workflows/ci.yml',
    '.github/second-eye.md',
    'scripts/second-eye-gate.ts',
    'scripts/second-eye-comment.ts',
    'infra/fly/app.tf',
    'apps/web/Dockerfile',
    'tools/bedrock-join/size/load/Dockerfile',
    'package.json',
    'apps/control/package.json',
    'bun.lock',
    'packages/db/src/schema.ts',
    'scripts/production.ts',
    'scripts/production-apply.ts',
    'scripts/staging.ts',
    'scripts/ops-run.ts',
    'apps/edge/src/main.ts',
    'apps/control/src/app/billing/charge.ts',
    'apps/control/src/app/access/rules.ts',
    'apps/control/src/infra/auth/session.ts',
    'apps/control/src/app/joins/join.ts',
    'apps/control/src/app/edge/ping-wake.ts',
    'apps/control/src/minecraft/wake-step.ts',
    'apps/control/src/infra/polar/polar-billing.ts',
    'apps/control/src/interfaces/billing/webhook.ts',
  ])('%s needs a second eye', (path) => expect(isSensitive(path)).toBe(true))

  test.each([
    'README.md',
    'apps/web/src/landing.tsx',
    'apps/control/src/app/servers/start.ts',
    'apps/control/src/app/accounts/profile.ts',
    'scripts/lib/pull-comment.ts',
    'docs/billing.md',
  ])('%s does not', (path) => expect(isSensitive(path)).toBe(false))
})

describe('startsByItself', () => {
  const mine: Start = {
    event: 'pull_request',
    action: 'opened',
    actor: MAINTAINER,
    triggeringActor: MAINTAINER,
    author: MAINTAINER,
    sameRepo: true,
    sensitive: true,
  }

  test("v0id-user's own sensitive pull request in this repository starts it", () => {
    expect(startsByItself(mine)).toBe(true)
    expect(startsByItself({ ...mine, action: 'synchronize' })).toBe(true)
  })

  test.each<[string, Partial<Start>]>([
    ['another account opened it', { author: 'someone', actor: 'someone', triggeringActor: 'someone' }],
    ['another account pushed to it', { actor: 'someone' }],
    ['another account re-ran it', { triggeringActor: 'someone' }],
    ['it is from a fork', { sameRepo: false }],
    ['it touches nothing sensitive', { sensitive: false }],
    ['it is a label, not a push', { action: 'labeled' }],
    ['it is a comment', { event: 'issue_comment' }],
    ['it is a fork-safe target event', { event: 'pull_request_target' }],
  ])('not when %s', (_name, change) => expect(startsByItself({ ...mine, ...change })).toBe(false))
})

describe('statusFor', () => {
  const none: Outcome = {
    event: 'pull_request',
    sensitive: 'true',
    mark: 'skipped',
    review: 'skipped',
    comment: 'skipped',
  }

  test('a pull request touching nothing sensitive passes at once', () => {
    expect(statusFor({ ...none, sensitive: 'false' })?.state).toBe('success')
  })

  test('a sensitive one nobody asked to review fails, saying who it waits for', () => {
    const status = statusFor(none)
    expect(status?.state).toBe('failure')
    expect(status?.description).toContain(`Waits for ${MAINTAINER} to request it`)
  })

  test('a finished review passes it', () => {
    expect(statusFor({ ...none, mark: 'success', review: 'success', comment: 'success' })?.state).toBe(
      'success',
    )
  })

  test('a review that did not finish, or waits for a draft, fails', () => {
    expect(statusFor({ ...none, mark: 'success', review: 'failure' })?.description).toContain("didn't finish")
    expect(statusFor({ ...none, mark: 'success' })?.description).toContain('ready for review')
  })

  test('a path check that failed is not a pass', () => {
    expect(statusFor({ ...none, sensitive: '' })?.state).toBe('failure')
  })

  test('a comment or a run by hand only adds a pass', () => {
    expect(statusFor({ ...none, event: 'issue_comment', mark: 'success', review: 'failure' })).toBeUndefined()
    expect(
      statusFor({
        ...none,
        event: 'workflow_dispatch',
        mark: 'success',
        review: 'success',
        comment: 'success',
      })?.state,
    ).toBe('success')
  })
})

describe('second-eye.yml', () => {
  const workflow = readFileSync(new URL('../.github/workflows/second-eye.yml', import.meta.url), 'utf8')
  const job = (name: string): string => {
    const start = workflow.indexOf(`\n  ${name}:\n`)
    const next = workflow.slice(start + 1).search(/\n {2}[a-z]+:\n/)
    return workflow.slice(start, next < 0 ? undefined : start + 1 + next)
  }

  test('the model runs only after the mark job, which asks v0id-user or the sensitive check', () => {
    const mark = job('mark')
    expect(mark).toContain("github.actor == 'v0id-user'")
    expect(mark).toContain("github.triggering_actor == 'v0id-user'")
    expect(mark).toContain("needs.sensitive.outputs.auto == 'true'")
    // A failed path check drops the automatic start only, never a request.
    expect(mark).toContain('!cancelled()')
    expect(mark).not.toContain('needs.sensitive.result')
    expect(job('review')).toContain('needs: mark')
    expect(job('comment')).toContain('needs: review')
    // Nothing else holds the token that runs the model.
    expect(workflow.match(/secrets\.CLAUDE_CODE_OAUTH_TOKEN/g)).toHaveLength(1)
    expect(job('sensitive')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(job('gate')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  test('a skipped review writes nothing: the notice step waits for the decision', () => {
    const mark = job('mark')
    expect(mark).toContain('id: decide')
    expect(mark).toContain("if: steps.decide.outputs.notice != 'none'")
    expect(mark).toContain('review: ${{ steps.decide.outputs.review }}')
    expect(workflow).toContain('force:')
  })

  test('the review and its comment run when the sensitive job above them is skipped', () => {
    // A comment or a run by hand skips the sensitive job, and an implicit success() would skip
    // every job below it.
    for (const name of ['review', 'comment']) {
      const section = job(name)
      expect(section).toContain('!cancelled()')
      expect(section).toContain(`needs.${name === 'review' ? 'mark' : 'review'}.result == 'success'`)
    }
  })
})
