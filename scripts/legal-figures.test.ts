// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plan facts the policies state (apps/web/src/legal/figures.ts) against the plan table the
 * control plane enforces. The web app may not import the control plane, so the check lives here.
 * A plan that changes fails this until the policies, and their date, change with it. A plan's
 * price and its hours a month move with what a new subscriber is offered, so the policies state
 * neither: they point to the Pricing and checkout pages.
 */
import { describe, expect, test } from 'bun:test'
import { CHIP_IN_CENTS } from '@blockly/contracts'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { PAST_DUE_GRACE_MS } from '../apps/control/src/app/billing/persistence.ts'
import { YEAR_REMINDER_DAYS as REMINDED } from '../apps/control/src/app/billing/years.ts'
import { JOINS_KEPT_DAYS, SOURCE_KEPT_AT_MOST_MS } from '../apps/control/src/app/joins/service.ts'
import { entitlementsFor, PAID_PLANS } from '../apps/control/src/domain/account/entitlements.ts'
import { UNIT_CENTS } from '../apps/control/src/domain/account/meter.ts'
import { DEFAULT_ABUSE_LIMITS } from '../apps/control/src/domain/account/tuning.ts'
import {
  dollars,
  EXTRA_HOUR_CENTS,
  FREE,
  FULL_REFUND_UNDER_HOURS,
  JOIN_ADDRESS_MINUTES,
  JOIN_RECORD_DAYS,
  KNOWN_NETWORK_DAYS,
  PAST_DUE_GRACE_DAYS,
  PLUS,
  type PlanFigures,
  YEAR_REMINDER_DAYS,
} from '../apps/web/src/legal/figures.ts'
import { POLICIES } from '../apps/web/src/legal/policies.ts'
import type { Block } from '../apps/web/src/legal/policy.ts'

describe('what the policies say about the plans', () => {
  for (const [key, said] of [
    ['free', FREE],
    ['plus', PLUS],
  ] as [string, PlanFigures][])
    test(`is what ${key} enforces`, () => {
      const plan = entitlementsFor(key)
      expect(said).toEqual({
        name: said.name,
        totalHours: plan.totalUnits,
        carryHours: plan.carryUnits,
        maxServers: plan.maxServers,
        sleepsAfterMinutes: plan.idleShutdownAfterMinutes ?? Number.NaN,
        restsAfterDays: plan.storeAfterIdleDays,
        deletedAfterDays: plan.deleteAfterIdleDays,
        backupsKept: plan.backupPolicy.snapshotsKept,
        trashDays: plan.trashRetentionDays,
        downloadDays: plan.backupPolicy.archiveRetentionDays,
      })
    })

  test('an extra hour costs what they say', () => {
    expect(EXTRA_HOUR_CENTS).toBe(UNIT_CENTS)
  })

  test('a year ending is emailed about when they say', () => {
    expect(YEAR_REMINDER_DAYS).toEqual(REMINDED)
  })

  test('a player network is kept as long as they say', () => {
    expect(DEFAULT_ABUSE_LIMITS.knownAddressDays).toBe(KNOWN_NETWORK_DAYS)
  })

  test('a join is kept, and the address it came from, as long as they say', () => {
    expect(JOINS_KEPT_DAYS).toBe(JOIN_RECORD_DAYS)
    expect(SOURCE_KEPT_AT_MOST_MS).toBeLessThanOrEqual(JOIN_ADDRESS_MINUTES * MINUTE_MS)
  })

  test('a failed renewal keeps the plan as long as they say', () => {
    expect(PAST_DUE_GRACE_DAYS * DAY_MS).toBe(PAST_DUE_GRACE_MS)
  })

  test('the full refund stops at 30 hours, under what Plus includes', () => {
    expect(FULL_REFUND_UNDER_HOURS).toBe(30)
    expect(FULL_REFUND_UNDER_HOURS).toBeLessThan(entitlementsFor('plus').includedUnits ?? Number.NaN)
  })

  test('state no plan’s price or hours a month: only figures no offer moves', () => {
    const text = POLICIES.flatMap(sentencesOf).join('\n')
    // The only amounts: an extra hour, and the least a chip-in takes.
    const amounts = new Set([...text.matchAll(/\$\d+(?:\.\d+)?/g)].map((found) => found[0]))
    expect([...amounts].sort()).toEqual([dollars(CHIP_IN_CENTS.min), dollars(EXTRA_HOUR_CENTS)].sort())
    expect(text).not.toMatch(/\d+ hours(?: of play)? (?:a|each|every) month/)
    for (const key of PAID_PLANS) {
      const plan = entitlementsFor(key)
      expect(text, key).not.toContain(dollars(plan.monthlyPriceCents))
      if (plan.yearlyPriceCents !== null) expect(text, key).not.toContain(dollars(plan.yearlyPriceCents))
      if (plan.includedUnits !== null)
        expect(text, key).not.toMatch(new RegExp(`\\b${plan.includedUnits} hours`))
    }
  })
})

/** Every sentence a policy holds: summary, headings, paragraphs, list items and table cells. */
function sentencesOf(policy: (typeof POLICIES)[number]): string[] {
  const ofBlock = (block: Block): string[] =>
    typeof block === 'string'
      ? [block]
      : 'list' in block
        ? [...block.list]
        : 'steps' in block
          ? [...block.steps]
          : [...block.table.head, ...block.table.rows.flat()]
  return [
    policy.description,
    ...policy.summary,
    ...policy.sections.flatMap((section) => [section.heading, ...section.blocks.flatMap(ofBlock)]),
  ]
}
