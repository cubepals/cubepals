// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Queryable } from '@blockly/db'

/**
 * Mutual exclusion that holds across every control-plane process: api and worker may run on
 * separate machines and still take turns.
 */
export interface Locks {
  /**
   * Runs `work` while holding `key`. Waits at most `waitMs` for it, then throws `LockBusy`. `work`
   * is given the connection that holds it, each statement saved as it runs, for work that must not
   * ask the pool for another while it keeps this one.
   */
  hold<T>(key: string, waitMs: number, work: (held: Queryable) => Promise<T>): Promise<T>
}

export class LockBusy extends Error {
  constructor(key: string) {
    super(`${key} stayed busy`)
    this.name = 'LockBusy'
  }
}
