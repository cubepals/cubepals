// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server page says while Cubepals starts a sleeping server, with nobody waiting, so the
 * server list shows the icon or message its owner just changed (`OperationView.refresh`). Its
 * steps and wait are a start's, said as showing the change rather than as a wake nobody asked
 * for; once it runs, the running line says when it sleeps again if nobody joins. Not the journey
 * of any other start, which `present.ts` keeps.
 */
import type { OperationView } from '@blockly/contracts'

/** The progress journey for a refresh, from the start's own, or null for any other operation. */
export function refreshJourney<J extends { title: string; steps: readonly { label: unknown }[] }>(
  operation: OperationView,
  start: J | undefined,
): J | null {
  if (operation.refresh !== true || start === undefined) return null
  return {
    ...start,
    title: 'Showing your changes in the server list',
    steps: start.steps.map((step, i) => (i === 0 ? { ...step, label: 'Starting with your changes' } : step)),
  }
}
