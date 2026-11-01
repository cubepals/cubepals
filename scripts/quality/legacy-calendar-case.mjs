// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Preserve the immutable fixture's existing calendar guard, never a proposed or broader skip. */
import { HOUR_MS } from '../../packages/contracts/src/durations.ts'

export const legacyCalendarCase = {
  path: 'apps/control/src/app/billing/extra-bounds.test.ts',
  sha256: '00869e121691c6a42b79e333c255c1b402ac0872258bc7c7b7271ec97b934107',
  name: 'extra play is counted up to the moment a cancel or a failed renewal stopped it',
}

const inOriginalWindow = (at) => {
  const month = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)
  return Number.isFinite(at.getTime()) && at.getTime() - month < 4 * HOUR_MS
}

export function legacyCalendarSkips(test, startedAt, finishedAt) {
  return test?.path === legacyCalendarCase.path &&
    test.sha256 === legacyCalendarCase.sha256 &&
    (inOriginalWindow(startedAt) || inOriginalWindow(finishedAt))
    ? new Set([JSON.stringify([test.path, legacyCalendarCase.name])])
    : new Set()
}
