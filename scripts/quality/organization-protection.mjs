// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Requires the trusted main workflows through an organization-owned rule, independently of
 * app-wide status names. Only one named rule for this exact repository/ref may be maintained;
 * unrelated rules and additional workflow requirements remain untouched.
 * Schema: https://docs.github.com/en/rest/orgs/rules#create-an-organization-repository-ruleset
 */
const ORGANIZATION = 'cubepals'
const REPOSITORY = 'cubepals/cubepals'
const REPOSITORY_ID = 1415897625
const RULESET_NAME = 'Cubepals automated test quality'
const ENDPOINT = `orgs/${ORGANIZATION}/rulesets`
const REF = 'refs/heads/main'
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/quality-policy.yml']
const CONDITIONS = {
  repository_id: { repository_ids: [REPOSITORY_ID] },
  ref_name: { include: [REF], exclude: [] },
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function readRuleset(api) {
  const named = []
  for (let page = 1; ; page++) {
    const rulesets = api(`${ENDPOINT}?per_page=100&page=${page}`)
    if (!Array.isArray(rulesets)) throw new Error('Organization ruleset listing is not an array')
    named.push(...rulesets.filter((rule) => rule.name === RULESET_NAME))
    if (rulesets.length < 100) break
    if (page >= 100) throw new Error('Organization ruleset pagination cannot be verified')
  }
  if (named.length > 1) throw new Error('Organization quality ruleset name is ambiguous')
  if (!named.length) return null
  const listed = named[0]
  if (!Number.isSafeInteger(listed.id) || listed.id <= 0)
    throw new Error('Organization quality ruleset has an invalid ID')
  const current = api(`${ENDPOINT}/${listed.id}`)
  if (
    current.id !== listed.id ||
    current.name !== RULESET_NAME ||
    current.source_type !== 'Organization' ||
    current.source !== ORGANIZATION ||
    current.target !== 'branch' ||
    !same(current.conditions, CONDITIONS)
  )
    throw new Error(
      'Organization quality ruleset name collides with a different owner or repository/ref scope',
    )
  if (
    !Array.isArray(current.rules) ||
    ['workflows', 'required_signatures', 'pull_request'].some(
      (type) => current.rules.filter((rule) => rule.type === type).length > 1,
    )
  )
    throw new Error('Organization quality workflow rule is malformed or ambiguous')
  return current
}

function workflowProblems(current) {
  if (!current) return ['Missing independently administered organization quality ruleset']
  const failures = []
  if (current.enforcement !== 'active') failures.push('Organization quality ruleset is not active')
  if (!Array.isArray(current.bypass_actors) || current.bypass_actors.length)
    failures.push('Organization quality ruleset must have no bypass actors')
  if (!current.rules.some((rule) => rule.type === 'required_signatures'))
    failures.push('Organization quality ruleset must require verified signatures')
  const pullRequest = current.rules.find((rule) => rule.type === 'pull_request')
  if (!pullRequest || !validPullRequest(pullRequest.parameters))
    failures.push('Organization quality ruleset must require pull requests')
  const workflow = current.rules.find((rule) => rule.type === 'workflows')
  if (!workflow || !Array.isArray(workflow.parameters?.workflows))
    return [...failures, 'Missing organization workflow requirements']
  if (workflow.parameters.do_not_enforce_on_create !== false)
    failures.push('Organization workflow rule must enforce branch creation')
  for (const path of WORKFLOWS) {
    const matches = workflow.parameters.workflows.filter(
      (entry) => entry.repository_id === REPOSITORY_ID && entry.path === path,
    )
    if (matches.length !== 1 || matches[0].ref !== REF || matches[0].sha != null)
      failures.push(`Missing exact trusted main workflow requirement: ${path}`)
  }
  return failures
}

function validPullRequest(parameters) {
  return (
    parameters &&
    Number.isInteger(parameters.required_approving_review_count) &&
    parameters.required_approving_review_count >= 0 &&
    [
      'dismiss_stale_reviews_on_push',
      'require_code_owner_review',
      'require_last_push_approval',
      'required_review_thread_resolution',
    ].every((key) => typeof parameters[key] === 'boolean')
  )
}

function desiredRuleset(current) {
  const rules = structuredClone(current?.rules ?? [])
  if (!rules.some((rule) => rule.type === 'required_signatures')) rules.push({ type: 'required_signatures' })
  const pullRequest = rules.find((rule) => rule.type === 'pull_request')
  if (pullRequest && !validPullRequest(pullRequest.parameters))
    throw new Error('Cannot preserve malformed organization pull-request requirements')
  if (!pullRequest)
    rules.push({
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    })
  let workflow = rules.find((rule) => rule.type === 'workflows')
  if (!workflow) {
    workflow = { type: 'workflows', parameters: { workflows: [] } }
    rules.push(workflow)
  }
  if (!Array.isArray(workflow.parameters?.workflows))
    throw new Error('Cannot preserve malformed organization workflow requirements')
  workflow.parameters.do_not_enforce_on_create = false
  for (const path of WORKFLOWS) {
    const matching = workflow.parameters.workflows.filter(
      (entry) => entry.repository_id === REPOSITORY_ID && entry.path === path,
    )
    if (matching.length > 1) throw new Error(`Ambiguous existing workflow requirement: ${path}`)
    const desired = { path, repository_id: REPOSITORY_ID, ref: REF }
    if (matching.length) {
      const index = workflow.parameters.workflows.indexOf(matching[0])
      workflow.parameters.workflows[index] = desired
    } else workflow.parameters.workflows.push(desired)
  }
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: CONDITIONS,
    rules,
  }
}

function preservationProblems(before, after) {
  if (!before || !after) return []
  const failures = before.rules
    .filter((rule) => rule.type !== 'workflows' && !after.rules.some((candidate) => same(rule, candidate)))
    .map((rule) => `Organization update did not preserve the existing ${rule.type} rule`)
  const previous = before.rules.find((rule) => rule.type === 'workflows')?.parameters.workflows ?? []
  const next = after.rules.find((rule) => rule.type === 'workflows')?.parameters.workflows ?? []
  for (const workflow of previous) {
    if (workflow.repository_id === REPOSITORY_ID && WORKFLOWS.includes(workflow.path)) continue
    if (!next.some((candidate) => same(workflow, candidate)))
      failures.push(`Organization update did not preserve additional workflow ${workflow.path}`)
  }
  return failures
}

/** All authorization, identity, scope and workflow-availability reads precede any mutations. */
export function planOrganizationProtection(api) {
  const repository = api(`repos/${REPOSITORY}`)
  if (repository.id !== REPOSITORY_ID || repository.full_name !== REPOSITORY)
    throw new Error('Repository identity does not match the quality protection policy')
  for (const path of WORKFLOWS) {
    const file = api(`repos/${REPOSITORY}/contents/${path}?ref=main`)
    if (file.type !== 'file' || file.path !== path || !/^[a-f0-9]{40}$/.test(file.sha ?? ''))
      throw new Error(`Trusted main workflow is unavailable: ${path}`)
  }
  const current = readRuleset(api)
  const desired = desiredRuleset(current)
  return {
    apply() {
      // A conforming rule is already strong enough. Do not rewrite it or unrelated rules.
      if (workflowProblems(current).length === 0) return
      if (current) api(`${ENDPOINT}/${current.id}`, desired)
      else api(ENDPOINT, desired, 'POST')
      const updated = readRuleset(api)
      const failures = [...workflowProblems(updated), ...preservationProblems(current, updated)]
      if (failures.length) throw new Error(failures.join('\n'))
    },
    verify() {
      return workflowProblems(readRuleset(api))
    },
  }
}
