// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Preserve the immutable fixture's existing calendar guard, never a proposed or broader skip. */
import { HOUR_MS } from '../../packages/contracts/src/durations.ts'

export const legacyCalendarCase = {
  path: 'apps/control/src/app/billing/extra-bounds.test.ts',
  sha256: '00869e121691c6a42b79e333c255c1b402ac0872258bc7c7b7271ec97b934107',
  name: 'extra play is counted up to the moment a cancel or a failed renewal stopped it',
  hours: 4,
}

export const legacyCalendarCases = [
  legacyCalendarCase,
  {
    path: 'apps/control/src/app/billing/extra-usage.test.ts',
    sha256: 'b4ff8dd9474abfc633a7281692d1e68af8057a9186897268432983d8af9663df',
    name: 'a running server stops for hours when what was allowed runs out, and says so',
    hours: 3,
  },
  {
    path: 'apps/control/src/app/billing/hours-lowered-mid-month.test.ts',
    sha256: '27bad18a443b8962b12d08a8b268dee87b03db270fac18350110e606eacdded8',
    name: 'hours played while an admin’s hours covered them are never billed as extra later',
    hours: 6,
  },
  {
    path: 'apps/control/src/app/billing/month-plus-began.test.ts',
    sha256: 'a9f58a0f07cfc4dc57ced221a9767bb77fb63f7b03bbfcc2246f33db538d8bfc',
    name: 'the month Plus begins in counts only play since Plus began',
    hours: 12,
  },
  ...[
    'a subscription that ends mid-month leaves Free’s hours in force at once',
    'hours an admin gives once Plus has ended are the month’s hours, not Plus’s',
  ].map((name) => ({
    path: 'apps/control/src/app/billing/plan-change-month-block.test.ts',
    sha256: '19b6f1f188bcec722a796e2b134049f20b00ee768511006b6be522de2b8bc388',
    name,
    hours: 5,
  })),
]

const inOriginalWindow = (at, hours) => {
  const month = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)
  return Number.isFinite(at.getTime()) && at.getTime() - month < hours * HOUR_MS
}

export function legacyCalendarSkips(test, startedAt, finishedAt) {
  return new Set(
    legacyCalendarCases
      .filter(
        (item) =>
          test?.path === item.path &&
          test.sha256 === item.sha256 &&
          (inOriginalWindow(startedAt, item.hours) || inOriginalWindow(finishedAt, item.hours)),
      )
      .map((item) => JSON.stringify([item.path, item.name])),
  )
}
