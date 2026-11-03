// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the settings kept as code write: the fields GitHub takes, and only what changed. */
import { describe, expect, test } from 'bun:test'
import { kept, plan, protectionFile, protectionKept, protectionPlan, type Ruleset } from './repo-settings.ts'

const main: Ruleset = {
  name: 'main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [{ type: 'pull_request' }, { type: 'required_signatures' }],
}

describe('the rulesets kept as code', () => {
  test('keep only what GitHub writes, in one order', () => {
    const live = {
      id: 7,
      node_id: 'RRS_x',
      source: 'cubepals/cubepals',
      source_type: 'Repository',
      created_at: '2026-10-12T00:00:00Z',
      _links: { self: { href: 'https://api.github.test' } },
      rules: main.rules,
      name: 'main',
      enforcement: 'active',
      target: 'branch',
      conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
    }
    expect(kept(live)).toEqual(main)
    expect(Object.keys(kept(live))).toEqual(['conditions', 'enforcement', 'name', 'rules', 'target'])
  })

  test('a ruleset that says the same in another key order is left alone', () => {
    const reordered = kept({
      ...main,
      conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
    })
    expect(plan([main], [{ id: 7, ruleset: reordered }])).toEqual([])
  })

  test('a changed ruleset is updated by id, a new one created, and one no file names deleted', () => {
    const changed: Ruleset = { ...main, rules: [{ type: 'pull_request' }] }
    const tags: Ruleset = {
      name: 'tags',
      target: 'tag',
      enforcement: 'active',
      rules: [{ type: 'deletion' }],
    }
    const old: Ruleset = { name: 'old', target: 'branch', enforcement: 'disabled', rules: [] }
    expect(
      plan(
        [changed, tags],
        [
          { id: 7, ruleset: main },
          { id: 9, ruleset: old },
        ],
      ),
    ).toEqual([
      { kind: 'update', name: 'main', id: 7, ruleset: changed },
      { kind: 'create', name: 'tags', ruleset: tags },
      { kind: 'delete', name: 'old', id: 9 },
    ])
  })

  test('with no ruleset written down, nothing is deleted', () => {
    expect(plan([], [{ id: 7, ruleset: main }])).toEqual([])
  })
})

/** A branch protection as GitHub's "Get branch protection" answers it, as its API docs give it. */
const answered = {
  url: 'https://api.github.test/repos/cubepals/cubepals/branches/main/protection',
  required_status_checks: {
    url: 'https://api.github.test/required_status_checks',
    strict: false,
    contexts: ['check', 'Second eye gate', 'Quality policy'],
    contexts_url: 'https://api.github.test/contexts',
    checks: [
      { context: 'check', app_id: 15368 },
      { context: 'Second eye gate', app_id: null },
      { context: 'Quality policy', app_id: 15368 },
    ],
  },
  required_pull_request_reviews: {
    url: 'https://api.github.test/required_pull_request_reviews',
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
  },
  required_signatures: { url: 'https://api.github.test/required_signatures', enabled: true },
  enforce_admins: { url: 'https://api.github.test/enforce_admins', enabled: false },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: false },
  required_conversation_resolution: { enabled: false },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
}

describe("a branch's protection kept as code", () => {
  test('is what the PUT takes: plain switches, checks by context with their app, no links', () => {
    const protection = protectionKept(answered)
    expect(protection.required_status_checks).toEqual({
      strict: false,
      checks: [
        { context: 'Quality policy', app_id: 15368 },
        { context: 'Second eye gate', app_id: -1 },
        { context: 'check', app_id: 15368 },
      ],
    })
    expect(protection.required_pull_request_reviews).toEqual({
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
    })
    expect(protection.restrictions).toBeNull()
    expect(protection.required_signatures).toBe(true)
    expect(protection.required_linear_history).toBe(true)
    expect(protection.enforce_admins).toBe(false)
    expect(JSON.stringify(protection)).not.toContain('url')
  })

  test('reads who may push and dismiss by login and slug', () => {
    const protection = protectionKept({
      ...answered,
      restrictions: { users: [{ login: 'b' }, { login: 'a' }], teams: [], apps: [{ slug: 'cubepals' }] },
      required_pull_request_reviews: {
        ...answered.required_pull_request_reviews,
        bypass_pull_request_allowances: { users: [], teams: [{ slug: 'core' }], apps: [] },
      },
    })
    expect(protection.restrictions).toEqual({ users: ['a', 'b'], teams: [], apps: ['cubepals'] })
    expect(protection.required_pull_request_reviews?.bypass_pull_request_allowances).toEqual({
      users: [],
      teams: ['core'],
      apps: [],
    })
  })

  test('a file that says what is live changes nothing, in any key or check order', () => {
    const live = protectionKept(answered)
    const file = JSON.parse(JSON.stringify(live))
    file.required_status_checks.checks.reverse()
    expect(protectionPlan('main', protectionKept({ ...answered }), live)).toEqual([])
    expect(
      protectionPlan('main', { ...file, required_status_checks: live.required_status_checks }, live),
    ).toEqual([])
  })

  test('a dropped check protects the branch again, leaving signed commits alone', () => {
    const live = protectionKept(answered)
    const wanted = {
      ...live,
      required_status_checks: {
        strict: false,
        checks:
          live.required_status_checks?.checks.filter((check) => check.context !== 'Quality policy') ?? [],
      },
    }
    expect(protectionPlan('main', wanted, live)).toEqual([
      { kind: 'protect', name: 'main', protection: wanted, signatures: false },
    ])
  })

  test('signed commits are written only when they change, and on a branch with no protection', () => {
    const live = protectionKept(answered)
    const unsigned = { ...live, required_signatures: false }
    expect(protectionPlan('main', unsigned, live)).toEqual([
      { kind: 'protect', name: 'main', protection: unsigned, signatures: true },
    ])
    expect(protectionPlan('main', live, null)).toEqual([
      { kind: 'protect', name: 'main', protection: live, signatures: true },
    ])
    expect(protectionPlan('main', unsigned, null)[0]).toMatchObject({ signatures: false })
  })
})

describe("a branch's file", () => {
  test('that holds the whole shape is read as it is', () => {
    const live = protectionKept(answered)
    expect(protectionFile('main.json', JSON.parse(JSON.stringify(live)))).toEqual(live)
  })

  test('that lacks a key the PUT requires, or holds one it does not take, is refused by name', () => {
    const { restrictions: _, ...partial } = protectionKept(answered)
    expect(() => protectionFile('main.json', partial)).toThrow('main.json lacks restrictions')
    expect(() => protectionFile('main.json', { ...protectionKept(answered), url: 'x' })).toThrow(
      "main.json holds url, which GitHub doesn't take",
    )
  })
})
