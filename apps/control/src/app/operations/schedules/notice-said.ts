// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on a server's owner, said in the server's chat in the pass that reads who is
 * on (`presence.ts`): to everyone on when someone who wasn't on at the last reading is, and again
 * every ten minutes while anyone is (`domain/account/notice.ts` `dueToSay`). Who was on and when it
 * was last said are kept per server (`notice_said`), so a control plane that restarts doesn't say
 * it again at once. A console that doesn't take it is asked again at the next reading, and nothing
 * here ever stops the pass.
 *
 * Not for what the notice says or when it limits the account (`app/accounts/notice.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { dueToSay } from '../../../domain/account/notice.ts'
import { announceNotice } from '../../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { PresentPlayer } from '../../servers/usage.ts'

const said = schema.noticeSaid

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((uuid) => b.includes(uuid))

/** Who was on at this reading, and when the notice was last said. */
async function keep(db: Db, serverId: string, players: string[], saidAt: Date | null): Promise<void> {
  await db
    .insert(said)
    .values({ serverId, players, saidAt })
    .onConflictDoUpdate({ target: said.serverId, set: { players, saidAt } })
}

/**
 * Says `notice` on the server, if it is due, to the `players` its console says are on now; and
 * keeps who they are. Nothing for an owner with no notice. A failure is only logged.
 */
export async function sayNotice(
  deps: { db: Db; console: Pick<ServerConsole, 'run'> },
  server: { id: string; target: ConsoleTarget },
  notice: string | undefined,
  players: readonly PresentPlayer[],
  now = new Date(),
): Promise<void> {
  if (notice === undefined) return
  try {
    const uuids = players.map((p) => p.uuid)
    const [row] = await deps.db.select().from(said).where(eq(said.serverId, server.id))
    const last = row === undefined ? null : { players: row.players, saidAt: row.saidAt }
    if (dueToSay(last, uuids, now)) {
      await deps.console.run(server.target, announceNotice(notice))
      await keep(deps.db, server.id, uuids, now)
    } else if (!sameSet(last?.players ?? [], uuids))
      await keep(deps.db, server.id, uuids, last?.saidAt ?? null)
  } catch (error) {
    console.warn('account notice', server.id, error instanceof Error ? error.message : error)
  }
}
