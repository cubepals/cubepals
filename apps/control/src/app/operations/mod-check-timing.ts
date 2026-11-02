// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { SECOND_MS } from '@blockly/contracts/durations'
import type { OperationStepJson } from '@blockly/db'

/** Measured check spans in the current attempt, excluding earlier attempts and retry queue waits. */
export function modCheckTiming(steps: readonly OperationStepJson[] | null): {
  modCheckSeconds?: number | null
} {
  if (steps === null) return {}
  const since = steps.findLastIndex((entry) => entry.step === 'attempt')
  let seconds: number | undefined
  for (const [index, start] of steps.entries()) {
    if (index <= since || start.step !== 'checking_mods') continue
    const end = steps[index + 1]
    if (end === undefined) return { modCheckSeconds: null }
    seconds = (seconds ?? 0) + Math.max(0, (Date.parse(end.at) - Date.parse(start.at)) / SECOND_MS)
  }
  return seconds === undefined ? {} : { modCheckSeconds: seconds }
}
