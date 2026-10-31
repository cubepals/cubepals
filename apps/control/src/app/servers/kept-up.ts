// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A start asked while a restore brings a backup back onto a server that was stopped: someone wants
 * to play it now, a join or its owner pressing Start. The restore leaves it up after, rather than
 * putting it back to sleep for the join to wake it again from cold (`handlers/restoring.ts` reads
 * it). Not where a start is decided otherwise: that is `decide`, in `domain/server/lifecycle.ts`.
 */
import type { Tx } from '@blockly/db'
import type { Command } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { keepUpAfterRestore } from '../operations/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { markActive } from './persistence.ts'
import { desiredRuns } from './revision-reads.ts'

/**
 * What follows a command `actor` gave, in its transaction, the server locked: where it is a start
 * and a restore bringing a backup back would put the server back to sleep, the restore leaves it up
 * for `actor` instead. Checked as a restart: a restoring server holds its running slot already. Its
 * run is then `actor`'s, so a join's sleeps after the probation if nobody joins it. Answers the
 * server as the command left it.
 */
export async function keptUp(
  tx: Tx,
  policy: Pick<AccessPolicy, 'require'>,
  actor: Actor,
  command: Command,
  server: MinecraftServer,
): Promise<MinecraftServer> {
  if (command.type !== 'start' || server.lifecycle.status !== 'restoring') return server
  if (!(await keepUpAfterRestore(tx, server.id, requestedBy(actor)))) return server
  await policy.require(tx, server.ownerId, {
    kind: 'restart_server',
    runs: await desiredRuns(tx, server),
    serverId: server.id,
  })
  // Its owner starting it is as good as playing, as with any start of theirs.
  if (actor.kind === 'user') await markActive(tx, server.id, new Date())
  return server
}
