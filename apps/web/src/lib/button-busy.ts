// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which button wears the server's work while it runs (`Button`'s and `ActionButton`'s `busy`):
 * the one whose press started it, in the server's words for it ("Applying your changes"), and
 * the power button for waking and sleeping, however they began. Every other button waits the
 * work out disabled, in its own words, rather than looking as if it had started a restore begun
 * on another card. Not the words themselves (`busyWord` in `present.ts`), or how a press ended
 * (`outcome.ts`).
 */
import type { OperationView } from '@blockly/contracts'
import type { Outcome } from './outcome'
import { busyWord } from './present'

/** The server's words for the work this press started, while it runs; nothing for other work. */
export function busyFor(
  outcome: Pick<Outcome, 'awaiting'>,
  view: { activeOperation: OperationView | null },
): string | undefined {
  const operation = view.activeOperation
  return operation !== null && operation.id === outcome.awaiting ? busyWord(operation) : undefined
}

/** What the power button is: a wake, a sleep, and a world resting or coming back from rest. */
const POWER: ReadonlySet<OperationView['kind']> = new Set(['start', 'stop', 'store', 'unstore'])

/**
 * The power button's words while the server works: its own work, whoever began it (a join wakes
 * a server too). Nothing for anything else, which it waits out disabled.
 */
export const powerBusy = (operation: OperationView | null): string | undefined =>
  operation !== null && POWER.has(operation.kind) ? busyWord(operation) : undefined
