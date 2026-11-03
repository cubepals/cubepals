// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the rulesets kept as code write: the fields GitHub takes, and only what changed. */
import { describe, expect, test } from 'bun:test'
import { kept, plan, type Ruleset } from './repo-settings.ts'

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
