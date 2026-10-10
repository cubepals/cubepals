// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { FreshStartView } from '@blockly/contracts'
import type { Queryable } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { runsLifeSteal, START_HEARTS } from '../../minecraft/lifesteal.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds, type WorldRecord } from './persistence.ts'

const WORDS = { season: 'Season', round: 'Round', world: 'World' } as const

/**
 * What starting over is on this server, read from what it plays, since a server keeps no record of
 * the template that made it: a new season where LifeStealZ runs, another round on a server made
 * for a day, a fresh world anywhere else. The new world is numbered after every world the server
 * has had, and is the kind of world the one it leaves is.
 */
export async function freshStartOf(
  q: Queryable,
  server: MinecraftServer,
): Promise<FreshStartView & { from: WorldRecord | undefined }> {
  const revision = await loadRevision(q, server.desiredRevisionId)
  const worlds = await listWorlds(q, server.id)
  const from = worlds.find((w) => w.id === server.activeWorldId)
  const kind = runsLifeSteal(revision.mods) ? 'season' : server.expiresAt === null ? 'world' : 'round'
  return {
    kind,
    name: `${WORDS[kind]} ${worlds.length + 1}`,
    leaving: from?.name ?? 'this world',
    hearts: kind === 'season' ? START_HEARTS : null,
    from,
  }
}
