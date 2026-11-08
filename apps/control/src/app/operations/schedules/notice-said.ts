// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on a server's owner, said in the server's chat in the pass that reads who is
 * on (`presence.ts`): to everyone on when someone who wasn't on at the last reading is, and again
 * every ten minutes while anyone is (`domain/account/notice.ts` `dueToSay`). Who was on and when it
 * was last said are kept per server (`notice_said`), so a control plane that restarts doesn't say
 * it again at once, with which notice it was, by when it was set: a pass that read a notice since
 * replaced, and says it and keeps that, never keeps the new one from being said at the next
 * reading. A console that doesn't take it is asked again at the next reading, and nothing here
 * ever stops the pass.
 *
 * Not for what the notice says or when it limits the account (`app/accounts/notice.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { AccountNotice } from '../../../domain/account/notice.ts'
import { dueToSay } from '../../../domain/account/notice.ts'
import { announceNotice } from '../../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { PresentPlayer } from '../../servers/usage.ts'

const said = schema.noticeSaid

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((uuid) => b.includes(uuid))

/** Who was on at this reading, and when the notice set at `noticeSetAt` was last said. */
async function keep(
  db: Db,
  serverId: string,
  noticeSetAt: Date,
  players: string[],
  saidAt: Date | null,
): Promise<void> {
  await db
    .insert(said)
    .values({ serverId, noticeSetAt, players, saidAt })
    .onConflictDoUpdate({ target: said.serverId, set: { noticeSetAt, players, saidAt } })
}

/**
 * Says `notice` on the server, if it is due, to the `players` its console says are on now; and
 * keeps who they are. What was kept of another notice counts as never said. Nothing for an owner
 * with no notice. A failure is only logged.
 */
export async function sayNotice(
  deps: { db: Db; console: Pick<ServerConsole, 'run'> },
  server: { id: string; target: ConsoleTarget },
  notice: Pick<AccountNotice, 'text' | 'setAt'> | undefined,
  players: readonly PresentPlayer[],
  now = new Date(),
): Promise<void> {
  if (notice === undefined) return
  try {
    const uuids = players.map((p) => p.uuid)
    const [row] = await deps.db.select().from(said).where(eq(said.serverId, server.id))
    const same = row?.noticeSetAt.getTime() === notice.setAt.getTime()
    const last = row === undefined ? null : { players: row.players, saidAt: same ? row.saidAt : null }
    if (dueToSay(last, uuids, now)) {
      await deps.console.run(server.target, announceNotice(notice.text))
      await keep(deps.db, server.id, notice.setAt, uuids, now)
    } else if (!same || !sameSet(last?.players ?? [], uuids))
      await keep(deps.db, server.id, notice.setAt, uuids, last?.saidAt ?? null)
  } catch (error) {
    console.warn('account notice', server.id, error instanceof Error ? error.message : error)
  }
}
