// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Word from the database that what a kept read was read from may have moved, so whoever keeps it
 * needn't ask again while nothing has. Word may come a moment after the write it is for, and may
 * be missed while the connection that hears it is down, which the mark says.
 */
export interface ChangeSignal {
  /**
   * A mark that moves with every change announced, and whenever announcements may have been
   * missed; null while none can be heard, when every read must ask the database.
   */
  mark(): number | null
}
