// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server page says while a world its owner brought in becomes the server's world: the
 * world by its name, never "backup" or "restore", which is how Cubepals does it underneath
 * (docs/world-import.md). Its steps and wait are a restore's (`restore-pace.ts`); only the words
 * differ. Not the journey of any other restore, which `present.ts` keeps.
 */
import type { OperationView } from '@blockly/contracts'
import { restoreSeconds } from './restore-pace'

/** The progress journey for a brought world's restore, or null for any other operation. */
export function broughtJourney(operation: OperationView) {
  // Going back from one that didn't start is said as for any restore.
  const name =
    operation.kind === 'restore' && operation.step !== 'rolling_back' ? operation.broughtWorld : null
  if (name === null) return null
  return {
    title: `Bringing ${name} to your server`,
    expectedSeconds: (_: unknown, op: OperationView) => restoreSeconds(op.worldBytes),
    steps: [
      { label: 'Keeping the world the server has now', covers: ['queued', 'saving'] },
      { label: `Fetching ${name}`, covers: ['storage', 'compute', 'allocating', 'waiting_for_room'] },
      { label: 'Setting it up', covers: ['booting'] },
      { label: 'Starting it up', covers: ['starting'] },
      { label: `Loading ${name}`, covers: ['loading_world', 'verifying', 'access'] },
    ],
  }
}

/** What the page says once it has: the world by its name. */
export const broughtLanded = (name: string): string => `${name} is your server’s world now.`
