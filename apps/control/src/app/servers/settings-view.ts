// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The Settings page combines the revision's game settings with this server's own idle-kick choice. */
import type { ServerView } from '@blockly/contracts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'

export function serverSettingsView(
  server: MinecraftServer,
  revision: Pick<ServerRevision, 'settings'>,
): Pick<ServerView, 'settings' | 'afkKickMinutes'> {
  return { settings: revision.settings, afkKickMinutes: server.afkKickMinutes }
}
