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
const organizationEndpoint = 'orgs/cubepals/rulesets'
const organizationList = `${organizationEndpoint}?per_page=100&page=1`
const repositoryId = 1415897625
const organizationRule = {
  id: 91,
  name: 'Cubepals automated test quality',
  source_type: 'Organization',
  source: 'cubepals',
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: {
    repository_id: { repository_ids: [repositoryId] },
    ref_name: { include: ['refs/heads/main'], exclude: [] },
  },
  rules: [
    { type: 'deletion' },
    { type: 'required_signatures' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 2,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
        require_last_push_approval: true,
        required_review_thread_resolution: true,
      },
    },
    {
      type: 'workflows',
      parameters: {
        do_not_enforce_on_create: false,
        workflows: [
          { repository_id: repositoryId, path: '.github/workflows/ci.yml', ref: 'refs/heads/main' },
          {
            repository_id: repositoryId,
            path: '.github/workflows/quality-policy.yml',
            ref: 'refs/heads/main',
          },
          { repository_id: 42, path: '.github/workflows/unrelated.yml', ref: 'refs/heads/release' },
        ],
      },
    },
  ],
}
const unrelatedRule = { ...organizationRule, id: 92, name: 'Unrelated organization protection' }
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
if (state.verifyAuthentication) {
  state.authentication = state.authentication || []
  state.authentication.push(state.expectedToken === null
    ? !Object.hasOwn(process.env, 'GH_TOKEN')
    : process.env.GH_TOKEN === state.expectedToken)
}
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
const failure = (state.failures || []).find(value => value.path === path && value.method === method)
if (failure) {
  save()
  process.stderr.write(failure.message)
  process.exit(1)
}
const signatures = path.endsWith('/required_signatures')
let response
if (path.startsWith('orgs/cubepals/rulesets')) {
  if (path.includes('?')) {
    if (method !== 'GET') throw new Error('unexpected list mutation')
    const page = Number(new URL(path, 'https://fixture.invalid').searchParams.get('page'))
    response = state.orgRulesets.slice((page - 1) * 100, page * 100)
  } else if (path === 'orgs/cubepals/rulesets' && method === 'POST') {
    response = { ...body, id: 99, source_type: 'Organization', source: 'cubepals' }
    if (!state.ignoreOrganizationWrite) state.orgRulesets.push({ ...response, ...state.organizationWriteTamper })
  } else {
    const id = Number(path.split('/').at(-1))
    const index = state.orgRulesets.findIndex(rule => rule.id === id)
    if (index < 0) throw new Error('missing organization ruleset')
    if (method === 'PUT' && !state.ignoreOrganizationWrite)
      state.orgRulesets[index] = { ...state.orgRulesets[index], ...body, ...state.organizationWriteTamper }
    else if (method !== 'GET' && method !== 'PUT') throw new Error('unexpected organization mutation')
    response = state.orgRulesets[index]
  }
} else if (path === 'repos/cubepals/cubepals') {
  if (method !== 'GET') throw new Error('unexpected repository mutation')
  response = state.repository || { id: 1415897625, full_name: 'cubepals/cubepals' }
} else if (path.startsWith('repos/cubepals/cubepals/contents/')) {
  if (method !== 'GET') throw new Error('unexpected workflow mutation')
  const file = path.slice('repos/cubepals/cubepals/contents/'.length).split('?')[0]
  if ((state.missingWorkflows || []).includes(file)) {
    save(); process.stderr.write('HTTP 404: trusted main workflow not found'); process.exit(1)
  }
  response = { type: 'file', path: file, sha: 'a'.repeat(40) }
} else if (method === 'POST' && signatures) {
  if (!state.ignoreSignatureEnable) state.signatures = { enabled: true }
} else if (method === 'PUT' && path === 'repos/cubepals/cubepals/branches/main/protection') {
  state.protection = { ...state.protection, ...body, enforce_admins: { enabled: body.enforce_admins } }
} else if (method !== 'GET') {
  save()
  throw new Error('unexpected mutation: ' + method + ' ' + path)
}
save()
process.stdout.write(JSON.stringify(response ?? (signatures ? state.signatures : state.protection)))
`

function invoke(mode, options = {}, credentialEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'quality-protection-'))
  const stateFile = join(directory, 'state.json')
  try {
    writeFileSync(join(directory, 'gh'), fakeGh, { mode: 0o755 })
    writeFileSync(
      stateFile,
      JSON.stringify({
        protection: current,
        signatures: { enabled: true },
        orgRulesets: [organizationRule, unrelatedRule],
        calls: [],
        ...options,
      }),
    )
    const result = spawnSync(process.execPath, [controller, mode], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...credentialEnv,
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
  assert.ok(result.state.calls.every((call) => call.method === 'GET'))
  assert.deepEqual(
    result.state.calls.filter((call) => call.path.startsWith(endpoint)),
    [
      { path: endpoint, method: 'GET', body: null },
      { path: signaturesEndpoint, method: 'GET', body: null },
    ],
  )
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
    result.state.calls
      .filter((call) => call.path.startsWith(endpoint))
      .map(({ path, method }) => ({ path, method })),
    [
      { path: endpoint, method: 'GET' },
      { path: signaturesEndpoint, method: 'POST' },
      { path: endpoint, method: 'PUT' },
      { path: endpoint, method: 'GET' },
      { path: signaturesEndpoint, method: 'GET' },
    ],
  )
  assert.equal(
    result.state.calls.find((call) => call.path === signaturesEndpoint && call.method === 'POST').body,
    null,
  )
  const body = result.state.calls.find((call) => call.path === endpoint && call.method === 'PUT').body
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
  assert.ok(result.state.calls.some((call) => call.path === signaturesEndpoint && call.method === 'GET'))
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

test('administrator token takes precedence over the inherited gh token without being printed', () => {
  const expectedToken = 'fixture-administrator-credential'
  const result = invoke(
    '--check',
    { verifyAuthentication: true, expectedToken },
    {
      CUBEPALS_ADMIN_GITHUB_TOKEN: expectedToken,
      GH_TOKEN: 'fixture-default-credential',
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.state.authentication.length > 2 && result.state.authentication.every(Boolean))
  assert.equal(result.stdout.includes(expectedToken) || result.stderr.includes(expectedToken), false)
})

test('an absent administrator token preserves the inherited gh token', () => {
  const expectedToken = 'fixture-default-credential'
  const result = invoke(
    '--check',
    { verifyAuthentication: true, expectedToken },
    {
      CUBEPALS_ADMIN_GITHUB_TOKEN: undefined,
      GH_TOKEN: expectedToken,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.state.authentication.length > 2 && result.state.authentication.every(Boolean))
})

test('absent tokens leave normal gh authentication configuration available', () => {
  const result = invoke(
    '--check',
    { verifyAuthentication: true, expectedToken: null },
    {
      CUBEPALS_ADMIN_GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.state.authentication.length > 2 && result.state.authentication.every(Boolean))
})

test('classic protection alone cannot satisfy the quality protection check', () => {
  const result = invoke('--check', { orgRulesets: [unrelatedRule] })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing independently administered organization/)
  assert.ok(result.state.calls.every((call) => call.method === 'GET'))
})

test('apply creates exact organization workflow, signature and pull-request requirements', () => {
  const result = invoke('--apply', { orgRulesets: [unrelatedRule] })
  assert.equal(result.status, 0, result.stderr)
  const created = result.state.orgRulesets.find((rule) => rule.name === organizationRule.name)
  assert.equal(created.source_type, 'Organization')
  assert.equal(created.enforcement, 'active')
  assert.deepEqual(created.bypass_actors, [])
  assert.deepEqual(created.conditions, organizationRule.conditions)
  assert.deepEqual(created.rules.find((rule) => rule.type === 'workflows').parameters, {
    do_not_enforce_on_create: false,
    workflows: organizationRule.rules
      .find((rule) => rule.type === 'workflows')
      .parameters.workflows.slice(0, 2),
  })
  assert.ok(created.rules.some((rule) => rule.type === 'required_signatures'))
  assert.equal(
    created.rules.find((rule) => rule.type === 'pull_request').parameters.required_approving_review_count,
    0,
  )
  assert.deepEqual(
    result.state.orgRulesets.find((rule) => rule.id === unrelatedRule.id),
    unrelatedRule,
  )
  assert.equal(
    result.state.calls.filter((call) => call.path === organizationEndpoint && call.method === 'POST').length,
    1,
  )
  const readback = invoke('--check', { orgRulesets: result.state.orgRulesets })
  assert.equal(readback.status, 0, readback.stderr)
  const repeated = invoke('--apply', { orgRulesets: result.state.orgRulesets })
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.ok(
    repeated.state.calls
      .filter((call) => call.path.startsWith(organizationEndpoint))
      .every((call) => call.method === 'GET'),
  )
})

test('apply repairs only the owned organization requirements and preserves stricter controls', () => {
  const weaker = structuredClone(organizationRule)
  weaker.enforcement = 'evaluate'
  weaker.bypass_actors = [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }]
  const workflows = weaker.rules.find((rule) => rule.type === 'workflows').parameters
  workflows.workflows.splice(1, 1)
  workflows.workflows[0].ref = 'refs/heads/untrusted'
  workflows.do_not_enforce_on_create = true
  const result = invoke('--apply', { orgRulesets: [weaker, unrelatedRule] })
  assert.equal(result.status, 0, result.stderr)
  const updated = result.state.orgRulesets.find((rule) => rule.id === organizationRule.id)
  assert.deepEqual(
    updated.rules.filter((rule) => rule.type !== 'workflows'),
    organizationRule.rules.filter((rule) => rule.type !== 'workflows'),
  )
  assert.deepEqual(
    updated.rules
      .find((rule) => rule.type === 'workflows')
      .parameters.workflows.find((entry) => entry.path.includes('unrelated')),
    workflows.workflows.find((entry) => entry.path.includes('unrelated')),
  )
  assert.deepEqual(
    result.state.orgRulesets.find((rule) => rule.id === unrelatedRule.id),
    unrelatedRule,
  )
  assert.equal(updated.enforcement, 'active')
  assert.deepEqual(updated.bypass_actors, [])
})

for (const [name, mutate] of [
  [
    'missing workflow',
    (rule) => rule.rules.find((value) => value.type === 'workflows').parameters.workflows.shift(),
  ],
  [
    'wrong source ref',
    (rule) => {
      rule.rules.find((value) => value.type === 'workflows').parameters.workflows[0].ref = 'refs/heads/topic'
    },
  ],
  [
    'wrong source repository',
    (rule) => {
      rule.rules.find((value) => value.type === 'workflows').parameters.workflows[0].repository_id = 1
    },
  ],
  [
    'obsolete pinned SHA',
    (rule) => {
      rule.rules.find((value) => value.type === 'workflows').parameters.workflows[0].sha = 'b'.repeat(40)
    },
  ],
  [
    'creation exemption',
    (rule) => {
      rule.rules.find((value) => value.type === 'workflows').parameters.do_not_enforce_on_create = true
    },
  ],
  [
    'bypass actor',
    (rule) => {
      rule.bypass_actors = [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }]
    },
  ],
  [
    'disabled enforcement',
    (rule) => {
      rule.enforcement = 'disabled'
    },
  ],
  [
    'missing organization signature rule',
    (rule) => {
      rule.rules = rule.rules.filter((value) => value.type !== 'required_signatures')
    },
  ],
  [
    'missing pull-request rule',
    (rule) => {
      rule.rules = rule.rules.filter((value) => value.type !== 'pull_request')
    },
  ],
]) {
  test(`check rejects organization ${name}`, () => {
    const invalid = structuredClone(organizationRule)
    mutate(invalid)
    const result = invoke('--check', { orgRulesets: [invalid] })
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /Organization|trusted main|organization/)
    assert.ok(result.state.calls.every((call) => call.method === 'GET'))
  })
}

for (const [name, mutate] of [
  [
    'different repository',
    (rule) => {
      rule.conditions.repository_id.repository_ids = [42]
    },
  ],
  [
    'additional repository',
    (rule) => {
      rule.conditions.repository_id.repository_ids.push(42)
    },
  ],
  [
    'all branches',
    (rule) => {
      rule.conditions.ref_name.include = ['~ALL']
    },
  ],
  [
    'excluded main',
    (rule) => {
      rule.conditions.ref_name.exclude = ['refs/heads/main']
    },
  ],
  [
    'repository-owned rule',
    (rule) => {
      rule.source_type = 'Repository'
    },
  ],
  [
    'different organization',
    (rule) => {
      rule.source = 'another-owner'
    },
  ],
]) {
  test(`apply refuses a named-rule collision with ${name} before any writes`, () => {
    const invalid = structuredClone(organizationRule)
    mutate(invalid)
    const result = invoke('--apply', { orgRulesets: [invalid] })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /collides/)
    assert.ok(result.state.calls.every((call) => call.method === 'GET'))
  })
}

test('duplicate named organization rulesets fail without choosing one', () => {
  const result = invoke('--apply', { orgRulesets: [organizationRule, { ...organizationRule, id: 93 }] })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /name is ambiguous/)
  assert.ok(result.state.calls.every((call) => call.method === 'GET'))
})

test('ruleset discovery traverses pagination before choosing a managed rule', () => {
  const others = Array.from({ length: 100 }, (_, index) => ({
    ...unrelatedRule,
    id: index + 100,
    name: `Other ${index}`,
  }))
  const result = invoke('--check', { orgRulesets: [...others, organizationRule] })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.state.calls.some((call) => call.path.endsWith('page=2')))
})

for (const message of ['HTTP 403: organization administration required', 'HTTP 404: rulesets unavailable']) {
  test(`unavailable organization authority or API fails closed: ${message}`, () => {
    const result = invoke('--apply', { failures: [{ path: organizationList, method: 'GET', message }] })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(message))
    assert.ok(result.state.calls.every((call) => call.method === 'GET'))
  })
}

test('unsupported organization workflow creation cannot silently leave only classic protection', () => {
  const result = invoke('--apply', {
    orgRulesets: [unrelatedRule],
    failures: [
      { path: organizationEndpoint, method: 'POST', message: 'HTTP 422: workflows rule is not supported' },
    ],
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not supported/)
  assert.ok(
    result.state.calls
      .filter((call) => call.path.startsWith(endpoint))
      .every((call) => call.method === 'GET'),
  )
  assert.deepEqual(result.state.orgRulesets, [unrelatedRule])
})

for (const options of [
  { ignoreOrganizationWrite: true },
  {
    organizationWriteTamper: {
      bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }],
    },
  },
]) {
  test(`successful organization API writes require independent readback: ${JSON.stringify(options)}`, () => {
    const result = invoke('--apply', { orgRulesets: [unrelatedRule], ...options })
    assert.equal(result.status, 1)
    assert.ok(
      result.state.calls
        .filter((call) => call.path.startsWith(endpoint))
        .every((call) => call.method === 'GET'),
    )
  })
}

test('repository identity mismatch and missing trusted main workflows prevent all writes', () => {
  for (const options of [
    { repository: { id: 42, full_name: 'cubepals/cubepals' } },
    { missingWorkflows: ['.github/workflows/quality-policy.yml'] },
  ]) {
    const result = invoke('--apply', options)
    assert.equal(result.status, 1)
    assert.ok(result.state.calls.every((call) => call.method === 'GET'))
  }
})

test('readback rejects losing unrelated rules or additional workflow requirements', () => {
  const withoutExtraWorkflow = structuredClone(organizationRule.rules)
  withoutExtraWorkflow.find((rule) => rule.type === 'workflows').parameters.workflows.pop()
  for (const rules of [
    organizationRule.rules.filter((rule) => rule.type !== 'deletion'),
    withoutExtraWorkflow,
  ]) {
    const result = invoke('--apply', {
      orgRulesets: [{ ...organizationRule, enforcement: 'evaluate' }, unrelatedRule],
      organizationWriteTamper: { rules },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /did not preserve/)
    assert.ok(
      result.state.calls
        .filter((call) => call.path.startsWith(endpoint))
        .every((call) => call.method === 'GET'),
    )
  }
})
