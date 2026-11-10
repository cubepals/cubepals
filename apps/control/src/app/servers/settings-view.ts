// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Settings page combines the revision's game settings with this server's own choices: its idle
 * kick, and whether players are told when the owner acts on them.
 */
import type { ServerView } from '@blockly/contracts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'

export function serverSettingsView(
  server: MinecraftServer,
  revision: Pick<ServerRevision, 'settings'>,
): Pick<ServerView, 'settings' | 'afkKickMinutes' | 'tellPlayers'> {
  return {
    settings: revision.settings,
    afkKickMinutes: server.afkKickMinutes,
    tellPlayers: server.tellPlayers,
  }
}
