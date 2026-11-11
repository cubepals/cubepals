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
import {
  entitlementsFor,
  PAID_PLANS,
  PLAN_KEYS,
  planName,
} from '../apps/control/src/domain/account/entitlements.ts'
import { UNIT_CENTS } from '../apps/control/src/domain/account/meter.ts'
import { DEFAULT_ABUSE_LIMITS } from '../apps/control/src/domain/account/tuning.ts'
import { FULL_REFUND_UNDER_HOURS as REFUND_LINE } from '../apps/control/src/domain/account/withdrawal.ts'
import {
  dollars,
  EXTRA_HOUR_CENTS,
  FULL_REFUND_UNDER_HOURS,
  JOIN_ADDRESS_MINUTES,
  JOIN_RECORD_DAYS,
  KNOWN_NETWORK_DAYS,
  PAST_DUE_GRACE_DAYS,
  PLAN_FIGURES,
  YEAR_REMINDER_DAYS,
} from '../apps/web/src/legal/figures.ts'
import { POLICIES, policyAt } from '../apps/web/src/legal/policies.ts'
import type { Block } from '../apps/web/src/legal/policy.ts'

describe('what the policies say about the plans', () => {
  test('covers every plan in the plan table, and no other', () => {
    expect(Object.keys(PLAN_FIGURES).sort()).toEqual([...PLAN_KEYS].sort())
  })

  for (const key of PLAN_KEYS)
    test(`is what ${key} enforces`, () => {
      const plan = entitlementsFor(key)
      expect(PLAN_FIGURES[key]).toEqual({
        name: planName(key),
        totalHours: plan.totalUnits,
        carryHours: plan.carryUnits,
        maxServers: plan.maxServers,
        maxPlayers: plan.settingCaps?.maxPlayers ?? null,
        mods: plan.mayUseMods,
        datapacks: plan.mayUseDatapacks,
        largerSizes: plan.allowedMemoryTiers.length > 1,
        extraHours: plan.mayBuyMore,
        mostExtraHours: plan.mostExtraUnits,
        ownAfkKick: plan.mayChooseAfkKick,
        byYear: plan.yearlyPriceCents !== null,
        sleepsAfterMinutes: plan.idleShutdownAfterMinutes ?? Number.NaN,
        restsAfterDays: plan.storeAfterIdleDays,
        deletedAfterDays: plan.deleteAfterIdleDays,
        backupsKept: plan.backupPolicy.snapshotsKept,
        weeklyDownload: plan.backupPolicy.archiveEnabled,
        downloadsPerDay: plan.backupPolicy.downloadsPerDay,
        trashDays: plan.trashRetentionDays,
        downloadDays: plan.backupPolicy.archiveRetentionDays,
      })
    })

  test('the Terms describe every plan by its name', () => {
    const terms = policyAt('terms')
    const plans = terms?.sections.find((section) => section.id === 'plans')
    const text = (plans?.blocks ?? []).flatMap(blockSentences).join('\n').toLowerCase()
    for (const key of PLAN_KEYS)
      expect(text, key).toContain(`**${key === 'free' ? 'the ' : ''}${planName(key).toLowerCase()}**`)
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

  test('the full refund stops at 30 hours, under what every paid plan includes', () => {
    expect(FULL_REFUND_UNDER_HOURS).toBe(30)
    // The control plane works out refunds to the same line.
    expect(FULL_REFUND_UNDER_HOURS).toBe(REFUND_LINE)
    for (const key of PAID_PLANS)
      expect(FULL_REFUND_UNDER_HOURS, key).toBeLessThan(entitlementsFor(key).includedUnits ?? Number.NaN)
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

/** The sentences a block holds: a paragraph, its list items or steps, or its table's cells. */
const blockSentences = (block: Block): string[] =>
  typeof block === 'string'
    ? [block]
    : 'list' in block
      ? [...block.list]
      : 'steps' in block
        ? [...block.steps]
        : [...block.table.head, ...block.table.rows.flat()]

/** Every sentence a policy holds: summary, headings, paragraphs, list items and table cells. */
function sentencesOf(policy: (typeof POLICIES)[number]): string[] {
  return [
    policy.description,
    ...policy.summary,
    ...policy.sections.flatMap((section) => [section.heading, ...section.blocks.flatMap(blockSentences)]),
  ]
}
