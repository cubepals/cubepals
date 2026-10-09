// The plan facts the policies state (apps/web/src/legal/figures.ts) against the plan table the
// control plane enforces. The web app may not import the control plane, so the check lives here.
// A plan that changes fails this until the policies, and their date, change with it.
import { describe, expect, test } from 'bun:test'
import { PAST_DUE_GRACE_MS } from '../apps/control/src/app/billing/persistence.ts'
import { entitlementsFor } from '../apps/control/src/domain/account/entitlements.ts'
import {
  FREE,
  FULL_REFUND_UNDER_HOURS,
  PAST_DUE_GRACE_DAYS,
  PLUS,
  type PlanFigures,
} from '../apps/web/src/legal/figures.ts'

const DAY_MS = 24 * 60 * 60 * 1000

describe('what the policies say about the plans', () => {
  for (const [key, said] of [
    ['free', FREE],
    ['plus', PLUS],
  ] as [string, PlanFigures][])
    test(`is what ${key} enforces`, () => {
      const plan = entitlementsFor(key)
      expect(said).toEqual({
        name: said.name,
        priceCents: plan.monthlyPriceCents,
        hours: plan.includedUnits ?? Number.NaN,
        maxServers: plan.maxServers,
        sleepsAfterMinutes: plan.idleShutdownAfterMinutes ?? Number.NaN,
        restsAfterDays: plan.storeAfterIdleDays,
        deletedAfterDays: plan.deleteAfterIdleDays,
        backupsKept: plan.backupPolicy.snapshotsKept,
        trashDays: plan.trashRetentionDays,
        downloadDays: plan.backupPolicy.archiveRetentionDays,
      })
    })

  test('a failed renewal keeps the plan as long as they say', () => {
    expect(PAST_DUE_GRACE_DAYS * DAY_MS).toBe(PAST_DUE_GRACE_MS)
  })

  test('the full refund stops at 30 hours, half of what Plus includes', () => {
    expect(FULL_REFUND_UNDER_HOURS).toBe(30)
    expect(FULL_REFUND_UNDER_HOURS * 2).toBe(entitlementsFor('plus').includedUnits ?? Number.NaN)
  })
})
