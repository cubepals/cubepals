// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's switch for Offline world progression (`progression.ts`): on or off, kept beside the
 * server, and audited, as the performance mods' switch is (`servers/switched.ts`); and its switch
 * for each part (`setPart`). A running server has a change at its next start, and a sleeping one at
 * its next wake, which boots once for it.
 */
import type { ProgressionPart } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import type { Actor } from '../actor.ts'
import type { EventBus } from '../ports/events.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import { OwnerSwitch } from '../servers/switched.ts'
import {
  progressionKind,
  progressionOff,
  progressionParts,
  setProgression,
  setProgressionPart,
} from './progression.ts'

const READ = ['gameVersion', 'loader', 'loaderVersion', 'modpack', 'mods'] as const

export class ProgressionSwitch extends OwnerSwitch {
  constructor(db: Db, events: EventBus) {
    super(db, events, {
      takes: async (tx, revisionId) =>
        progressionKind(await loadRevisionFields(tx, revisionId, READ)) !== null,
      notFor:
        'Offline world progression runs on Paper, plain Minecraft on Paper, and Fabric 26.3, without a modpack.',
      off: progressionOff,
      set: (tx, serverId, on) => setProgression(tx, serverId, on, 'owner'),
      audited: { on: 'server.progression_on', off: 'server.progression_off' },
    })
  }

  /** Turns one of its parts on or off for the server's next start; a press that changes nothing records nothing. */
  setPart(actor: Actor, serverId: string, part: ProgressionPart, on: boolean): Promise<void> {
    return this.change(actor, serverId, async (tx) => {
      if ((await progressionParts(tx, serverId))[part] === on) return null
      await setProgressionPart(tx, serverId, part, on)
      return { action: on ? 'server.progression_part_on' : 'server.progression_part_off', data: { part } }
    })
  }
}
