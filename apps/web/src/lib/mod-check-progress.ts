// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** No completion fraction or finish time is known before the real loader answers. */
import type { OperationView } from '@blockly/contracts'

export function checkingModsProgress() {
  return {
    title: 'Checking the server’s mods',
    steps: [{ label: 'Testing these mods together', state: 'active' as const, indeterminate: true }],
    percent: 0,
    expectedSeconds: null,
    index: 0,
  }
}

export function checkEstimate(
  seconds: number,
  operation: Pick<OperationView, 'step' | 'modCheckSeconds'>,
): number | null {
  if (operation.step === 'checking_mods' || operation.modCheckSeconds === null) return null
  return seconds + (operation.modCheckSeconds ?? 0)
}

export function journeyEstimate<T>(
  estimate: number | ((server: T, operation: OperationView) => number),
  server: T,
  operation: OperationView,
): number | null {
  return checkEstimate(typeof estimate === 'number' ? estimate : estimate(server, operation), operation)
}
