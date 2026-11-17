// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's switch for the performance mods Cubepals adds to a Fabric server (`performance.ts`):
 * on or off, kept beside the server, and audited as its idle kick is (`servers/afk-kick.ts`), as
 * every such switch is (`servers/switched.ts`). Nobody playing is interrupted for mods that only
 * make the game cheaper to run: a running server has the change at its next start.
 *
 * What the settings page shows of them is `performance-view.ts`'s.
 */
import type { Db } from '@blockly/db'
import type { EventBus } from '../ports/events.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import { OwnerSwitch } from '../servers/switched.ts'
import { performanceOff, setPerformance, takesPerformance } from './performance.ts'

export class PerformanceSwitch extends OwnerSwitch {
  constructor(db: Db, events: EventBus) {
    super(db, events, {
      takes: async (tx, revisionId) =>
        takesPerformance(await loadRevisionFields(tx, revisionId, ['loader', 'modpack'])),
      notFor: 'Cubepals adds performance mods only to Fabric servers without a modpack.',
      off: performanceOff,
      set: (tx, serverId, on) => setPerformance(tx, serverId, on, 'owner'),
      audited: { on: 'server.performance_mods_on', off: 'server.performance_mods_off' },
    })
  }
}
