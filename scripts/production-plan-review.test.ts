// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A production plan is refused when it moves a play name's wildcard or gives the Fly apps a
 * setting of Terraform's own. The two plans in production-plans.fixture.json are real ones, made
 * against production's state with `terraform plan -out` and read with `terraform show -json`:
 * `nightlyBefore445` by v0.1.159-nightly.20261110.193, the last nightly before PLAY_IPV4 (#445),
 * and `main` by 4c9a1390. Kept are the wildcard, challenge and play-setting resources, the edge's
 * addresses and the play settings; addresses are swapped for documentation ones (RFC 5737, 3849).
 * The other cases are those plans with one change made.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Plan, planProblems, type ResourceChange, terraformOnly } from './production-plan-review.ts'

const PLANS = JSON.parse(readFileSync(join(import.meta.dir, 'production-plans.fixture.json'), 'utf8')) as {
  nightlyBefore445: Plan
  main: Plan
}
const OWN = terraformOnly(readFileSync(join(import.meta.dir, '../infra/terraform/stack/main.tf'), 'utf8'))
const WILDCARD_V4 = 'module.environment.module.dns.cloudflare_dns_record.play_v4["play.cubepals.com"]'
/** The edge's own anycast IPv4 in the fixture; PLAY_IPV4 there is 203.0.113.7. */
const ANYCAST = '198.51.100.1'

/** `plan` with the change at `address` set to `change`, and the settings merged with `settings`. */
function edited(
  plan: Plan,
  address: string,
  change: Partial<ResourceChange['change']>,
  settings: Record<string, string> = {},
): Plan {
  const copy = structuredClone(plan)
  const found = copy.resource_changes?.find((c) => c.address === address)
  if (!found) throw new Error(`${address} isn't in the plan`)
  Object.assign(found.change, change)
  const value = copy.variables?.settings?.value as Record<string, string>
  Object.assign(value, settings)
  return copy
}

describe("Terraform's own settings", () => {
  test('are read from the stack, and PLAY_IPV4 is one', () => {
    expect(OWN).toContain('PLAY_IPV4')
  })

  test('a stack that no longer names them is an error, never an empty list', () => {
    expect(() => terraformOnly('locals {}')).toThrow('terraform_only')
  })
})

describe('a real production plan', () => {
  test('from the nightly before #445: the wildcard goes to the anycast address, and both apps get PLAY_IPV4', () => {
    expect(planProblems(PLANS.nightlyBefore445, OWN)).toEqual([
      'module.environment.module.control.fly_secret.setting["control/PLAY_IPV4"]: gives bly-prod-control PLAY_IPV4, which is Terraform\'s alone (terraform_only in stack/main.tf).',
      'module.environment.module.control.fly_secret.setting["realtime/PLAY_IPV4"]: gives bly-prod-realtime PLAY_IPV4, which is Terraform\'s alone (terraform_only in stack/main.tf).',
      `${WILDCARD_V4}: would send play.cubepals.com's players to ${ANYCAST}, not 203.0.113.7 (PLAY_IPV4).`,
    ])
  })

  test("from main: nothing it changes is the review's concern", () => {
    expect(planProblems(PLANS.main, OWN)).toEqual([])
  })
})

describe('the play names’ wildcard', () => {
  test('may go to the edge’s own address once PLAY_IPV4 is emptied', () => {
    expect(
      planProblems(edited(PLANS.nightlyBefore445, WILDCARD_V4, {}, { PLAY_IPV4: '' }), OWN),
    ).not.toContainEqual(expect.stringContaining(WILDCARD_V4))
  })

  test('may go to a new PLAY_IPV4', () => {
    const plan = edited(
      PLANS.main,
      WILDCARD_V4,
      { actions: ['update'], after: { content: '203.0.113.20', name: '*.play.cubepals.com', type: 'A' } },
      { PLAY_IPV4: '203.0.113.20' },
    )
    expect(planProblems(plan, OWN)).toEqual([])
  })

  test('is never replaced', () => {
    const plan = edited(PLANS.main, WILDCARD_V4, { actions: ['delete', 'create'] })
    expect(planProblems(plan, OWN)).toEqual([
      `${WILDCARD_V4}: replaced, which leaves play.cubepals.com's players without an address in between.`,
    ])
  })

  test('is removed only once its domain is no longer listed', () => {
    const removed = edited(PLANS.main, WILDCARD_V4, { actions: ['delete'], after: null })
    expect(planProblems(removed, OWN)).toEqual([
      `${WILDCARD_V4}: removed, while play.cubepals.com is still a play domain.`,
    ])
    const moved = edited(
      PLANS.main,
      WILDCARD_V4,
      { actions: ['delete'], after: null },
      { PLAY_DOMAIN: 'play.example.com' },
    )
    expect(planProblems(moved, OWN)).toEqual([])
  })

  test('may not take an address known only once applied while PLAY_IPV4 names one', () => {
    const plan = edited(PLANS.main, WILDCARD_V4, {
      actions: ['update'],
      after: { name: '*.play.cubepals.com', type: 'A' },
      after_unknown: { content: true },
    })
    expect(planProblems(plan, OWN)).toEqual([
      `${WILDCARD_V4}: would hold an address known only once applied, not 203.0.113.7 (PLAY_IPV4).`,
    ])
  })
})

describe("the Fly apps' settings", () => {
  test('a setting production still gives a value is never removed', () => {
    const address = 'module.environment.module.control.fly_secret.setting["control/PLAY_IPV4_BY_REGION"]'
    const plan = edited(PLANS.main, address, { actions: ['delete'], after: null })
    expect(planProblems(plan, OWN)).toEqual([
      `${address}: removes PLAY_IPV4_BY_REGION from bly-prod-control, while the settings give it a value.`,
    ])
  })

  test('one of Terraform’s own, given by an older deploy, may be removed', () => {
    const address = 'module.environment.module.control.fly_secret.setting["control/PLAY_IPV4"]'
    const plan = edited(PLANS.nightlyBefore445, address, {
      actions: ['delete'],
      before: { app: 'bly-prod-control', name: 'PLAY_IPV4' },
      after: null,
    })
    expect(planProblems(plan, OWN)).not.toContainEqual(expect.stringContaining(address))
  })
})

test('a plan in a format this review doesn’t read is refused', () => {
  expect(planProblems({ ...PLANS.main, format_version: '2.0' }, OWN)).toEqual([
    "The plan is in Terraform's JSON format 2.0; this review reads 1.x.",
  ])
})
