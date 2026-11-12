// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server page says while Cubepals starts a sleeping server with nobody waiting
 * (`OperationView.refresh`): so the server list shows the icon or message its owner just changed,
 * or, where they changed nothing, to keep it ready for its next join
 * (`OperationView.keepsReady`). Its steps and wait are a start's, said as what it is for rather
 * than as a wake nobody asked for; once it runs, the running line says when it sleeps again if
 * nobody joins. Not the journey of any other start, which `present.ts` keeps.
 */
import type { OperationView } from '@blockly/contracts'

/** The progress journey for a refresh, from the start's own, or null for any other operation. */
export function refreshJourney<J extends { title: string; steps: readonly { label: unknown }[] }>(
  operation: OperationView,
  start: J | undefined,
): J | null {
  if (operation.refresh !== true || start === undefined) return null
  const [title, first] =
    operation.keepsReady === true
      ? ['Keeping your server ready', 'Starting in the background']
      : ['Showing your changes in the server list', 'Starting with your changes']
  return {
    ...start,
    title,
    steps: start.steps.map((step, i) => (i === 0 ? { ...step, label: first } : step)),
  }
}
