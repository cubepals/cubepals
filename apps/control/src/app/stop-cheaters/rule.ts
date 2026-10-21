// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether Stop cheaters runs on a server, and why. The owner's `on` and `off` decide; at `auto`,
 * Cubepals' default, it runs on a server flagged official and one made from a template strangers
 * join. Whether the server is published is not part of the rule: publishing stores `on`
 * (`onAtPublish`), so unpublishing changes nothing.
 */
import type { StopCheatersSetting, StopCheatersView } from '@blockly/contracts'

/** The templates made for strangers, which start with Stop cheaters on. */
export const STRANGERS_TEMPLATES = ['duels', 'arcade'] as const

/** A server's setting as stored, and what the rule reads beside it. */
export interface StopCheatersRow {
  setting: StopCheatersSetting
  reason: 'browse' | null
  template: string | null
  takeOver: boolean
  official: boolean
}

/** Whether it runs at the next start, and why Cubepals turned it on where the owner didn't. */
export function effective(row: Pick<StopCheatersRow, 'setting' | 'reason' | 'template' | 'official'>): {
  on: boolean
  why: StopCheatersView['why']
} {
  if (row.setting === 'off') return { on: false, why: null }
  if (row.setting === 'on') return { on: true, why: row.reason }
  if (row.official) return { on: true, why: 'official' }
  if ((STRANGERS_TEMPLATES as readonly (string | null)[]).includes(row.template))
    return { on: true, why: 'template' }
  return { on: false, why: null }
}
