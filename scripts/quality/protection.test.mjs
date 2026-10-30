// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Exercises the real protection CLI with a fake gh; no repository or live protection is changed. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const controller = fileURLToPath(new URL('./protection.mjs', import.meta.url))
const endpoint = 'repos/cubepals/cubepals/branches/main/protection'
const signaturesEndpoint = `${endpoint}/required_signatures`
const current = {
  required_status_checks: {
    strict: true,
    checks: [
      { context: 'check', app_id: 15368 },
      { context: 'Quality policy', app_id: 15368 },
      { context: 'Another required check', app_id: 42 },
    ],
    contexts: ['Legacy required check'],
  },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 2,
    require_last_push_approval: true,
    dismissal_restrictions: { users: [{ login: 'maintainer' }], teams: [], apps: [] },
    bypass_pull_request_allowances: { users: [], teams: [{ slug: 'reviewers' }], apps: [] },
  },
  restrictions: { users: [{ login: 'maintainer' }], teams: [{ slug: 'release' }], apps: [{ slug: 'bot' }] },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: true },
  required_conversation_resolution: { enabled: true },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
}

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs')
const stateFile = process.env.QUALITY_PROTECTION_STATE
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(2)
const path = args[1]
const methodIndex = args.indexOf('--method')
const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1]
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null
state.calls.push({ path, method, body })
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
const failure = (state.failures || []).find(value => value.path === path && value.method === method)
if (failure) {
  save()
  process.stderr.write(failure.message)
  process.exit(1)
}
const signatures = path.endsWith('/required_signatures')
if (method === 'POST' && signatures) {
  if (!state.ignoreSignatureEnable) state.signatures = { enabled: true }
} else if (method === 'PUT' && !signatures) {
  state.protection = { ...state.protection, ...body, enforce_admins: { enabled: body.enforce_admins } }
} else if (method !== 'GET') {
  save()
  throw new Error('unexpected mutation: ' + method + ' ' + path)
}
save()
process.stdout.write(JSON.stringify(signatures ? state.signatures : state.protection))
`

function invoke(mode, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'quality-protection-'))
  const stateFile = join(directory, 'state.json')
  try {
    writeFileSync(join(directory, 'gh'), fakeGh, { mode: 0o755 })
    writeFileSync(
      stateFile,
      JSON.stringify({ protection: current, signatures: { enabled: true }, calls: [], ...options }),
    )
    const result = spawnSync(process.execPath, [controller, mode], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: directory + delimiter + process.env.PATH,
        QUALITY_PROTECTION_STATE: stateFile,
      },
    })
    return { ...result, state: JSON.parse(readFileSync(stateFile, 'utf8')) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('check reads dedicated signature protection and never writes', () => {
  const result = invoke('--check')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /verified signed commits/)
  assert.deepEqual(result.state.calls, [
    { path: endpoint, method: 'GET', body: null },
    { path: signaturesEndpoint, method: 'GET', body: null },
  ])
})

for (const signatures of [{ enabled: false }, {}, { enabled: 'true' }]) {
  test(`check refuses absent or unverified signature enforcement: ${JSON.stringify(signatures)}`, () => {
    const result = invoke('--check', { signatures })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Verified signed commits are not required/)
    assert.ok(result.state.calls.every((call) => call.method === 'GET'))
  })
}

for (const message of ['HTTP 403: Resource not accessible', 'HTTP 404: Not Found', 'network unavailable']) {
  test(`check fails closed when signature protection cannot be read: ${message}`, () => {
    const result = invoke('--check', { failures: [{ path: signaturesEndpoint, method: 'GET', message }] })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(message))
    assert.ok(result.state.calls.every((call) => call.method === 'GET'))
  })
}

test('apply enables signed commits separately and preserves existing protection', () => {
  const protection = structuredClone(current)
  protection.enforce_admins.enabled = false
  protection.required_status_checks.strict = false
  protection.required_status_checks.checks = protection.required_status_checks.checks.filter(
    (check) => check.context !== 'Quality policy',
  )
  const result = invoke('--apply', { protection, signatures: { enabled: false } })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    result.state.calls.map(({ path, method }) => ({ path, method })),
    [
      { path: endpoint, method: 'GET' },
      { path: signaturesEndpoint, method: 'POST' },
      { path: endpoint, method: 'PUT' },
      { path: endpoint, method: 'GET' },
      { path: signaturesEndpoint, method: 'GET' },
    ],
  )
  assert.equal(result.state.calls[1].body, null)
  const body = result.state.calls[2].body
  assert.equal(body.required_status_checks.strict, true)
  assert.equal(body.enforce_admins, true)
  assert.ok(
    body.required_status_checks.checks.some(
      (check) => check.context === 'Quality policy' && check.app_id === 15368,
    ),
  )
  assert.ok(
    body.required_status_checks.checks.some(
      (check) => check.context === 'Another required check' && check.app_id === 42,
    ),
  )
  assert.ok(body.required_status_checks.checks.some((check) => check.context === 'Legacy required check'))
  assert.deepEqual(body.required_pull_request_reviews, {
    ...current.required_pull_request_reviews,
    dismissal_restrictions: { users: ['maintainer'], teams: [], apps: [] },
    bypass_pull_request_allowances: { users: [], teams: ['reviewers'], apps: [] },
  })
  assert.deepEqual(body.restrictions, { users: ['maintainer'], teams: ['release'], apps: ['bot'] })
  for (const key of [
    'required_linear_history',
    'allow_force_pushes',
    'allow_deletions',
    'block_creations',
    'required_conversation_resolution',
    'lock_branch',
    'allow_fork_syncing',
  ]) {
    assert.equal(body[key], current[key].enabled, key)
  }
  assert.equal(result.state.signatures.enabled, true)
})

test('apply verifies the signature state instead of trusting a successful POST', () => {
  const result = invoke('--apply', { signatures: { enabled: false }, ignoreSignatureEnable: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Verified signed commits are not required/)
  assert.equal(result.state.calls.at(-1).path, signaturesEndpoint)
  assert.equal(result.state.calls.at(-1).method, 'GET')
})

test('a denied initial protection read prevents every write', () => {
  const result = invoke('--apply', {
    failures: [{ path: endpoint, method: 'GET', message: 'HTTP 403: Resource not accessible' }],
  })
  assert.equal(result.status, 1)
  assert.deepEqual(result.state.calls, [{ path: endpoint, method: 'GET', body: null }])
})

test('a denied signature POST prevents the bulk protection update', () => {
  const result = invoke('--apply', {
    failures: [{ path: signaturesEndpoint, method: 'POST', message: 'HTTP 403: Resource not accessible' }],
  })
  assert.equal(result.status, 1)
  assert.ok(result.state.calls.every((call) => call.method !== 'PUT' && call.method !== 'DELETE'))
  assert.deepEqual(result.state.protection, current)
})
