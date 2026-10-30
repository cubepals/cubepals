// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audits or provisions classic main protection without replacing unrelated required checks,
 * review rules, or push restrictions. Needs a GitHub credential with repository administration.
 * It cannot install an organization required-workflow rule or prevent an administrator editing
 * protection; use a separately administered required workflow for a stronger trust boundary.
 *
 * node scripts/quality/protection.mjs --check
 * node scripts/quality/protection.mjs --apply
 */
import { execFileSync } from 'node:child_process'

const REPOSITORY = 'cubepals/cubepals'
const BRANCH = 'main'
const REQUIRED = ['check', 'Quality policy']
const ACTIONS_APP = 15368

function api(path, body) {
  const args = ['api', path]
  if (body) args.push('--method', 'PUT', '--input', '-')
  return JSON.parse(
    execFileSync('gh', args, {
      encoding: 'utf8',
      input: body ? JSON.stringify(body) : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  )
}

function identities(value) {
  return value
    ? {
        users: (value.users ?? []).map((user) => user.login),
        teams: (value.teams ?? []).map((team) => team.slug),
        apps: (value.apps ?? []).map((app) => app.slug),
      }
    : null
}

function reviewPolicy(current) {
  if (!current) return null
  const result = {}
  for (const key of [
    'dismiss_stale_reviews',
    'require_code_owner_reviews',
    'required_approving_review_count',
    'require_last_push_approval',
  ]) {
    if (current[key] !== undefined) result[key] = current[key]
  }
  for (const key of ['dismissal_restrictions', 'bypass_pull_request_allowances']) {
    if (current[key] !== undefined) result[key] = identities(current[key])
  }
  return result
}

function problems(current) {
  const checks = current.required_status_checks?.checks ?? []
  const missing = REQUIRED.filter(
    (context) => !checks.some((check) => check.context === context && check.app_id === ACTIONS_APP),
  )
  return [
    ...missing.map((context) => `Missing required GitHub Actions check: ${context}`),
    ...(!current.enforce_admins?.enabled ? ['Administrators can bypass protection'] : []),
    ...(!current.required_status_checks?.strict
      ? ['Required checks do not require an up-to-date branch']
      : []),
  ]
}

try {
  const mode = process.argv[2] ?? '--check'
  if (!['--check', '--apply'].includes(mode) || process.argv.length > 3)
    throw new Error('usage: protection.mjs [--check|--apply]')
  const endpoint = `repos/${REPOSITORY}/branches/${BRANCH}/protection`
  let current = api(endpoint)
  if (mode === '--apply') {
    const checks = [...(current.required_status_checks?.checks ?? [])]
    for (const context of REQUIRED) {
      const existing = checks.find((check) => check.context === context)
      if (existing) existing.app_id = ACTIONS_APP
      else checks.push({ context, app_id: ACTIONS_APP })
    }
    // Older protection responses may include context names without structured checks.
    for (const context of current.required_status_checks?.contexts ?? []) {
      if (!checks.some((check) => check.context === context)) checks.push({ context, app_id: -1 })
    }
    const body = {
      required_status_checks: { strict: true, checks },
      enforce_admins: true,
      required_pull_request_reviews: reviewPolicy(current.required_pull_request_reviews),
      restrictions: identities(current.restrictions),
    }
    for (const key of [
      'required_linear_history',
      'allow_force_pushes',
      'allow_deletions',
      'block_creations',
      'required_conversation_resolution',
      'lock_branch',
      'allow_fork_syncing',
    ]) {
      if (current[key] !== undefined) body[key] = current[key].enabled
    }
    api(endpoint, body)
    current = api(endpoint)
  }
  const failures = problems(current)
  if (failures.length) throw new Error(failures.join('\n'))
  process.stdout.write(
    'Main requires CI and the quality policy, including administrators, on an up-to-date branch.\n',
  )
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message
  console.error(`Quality protection is not verified: ${detail}`)
  process.exitCode = 1
}
