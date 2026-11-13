// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How far a join got, as conditions over `joins`, by who on its server's side could tell. The
 * reporter plugin tells each step with its own time (`login_at` to `in_world_at`). The server's
 * own player list, read about once a minute (`player-list.ts`), tells only that the player was on
 * it (`detail.listedAt`) or, a minute or more after the join was handed over, still wasn't
 * (`detail.notListedAt`). Either says a join got in. A join neither could have told of is not
 * known: it is called neither in the world nor stopped short.
 *
 * Not for how long a join took: the list's moments are up to a reading late, so only the
 * reporter's own times measure that (`signal-kinds.ts`, `server-events.ts`).
 */
import type { VitalsSource } from '@blockly/contracts/server-vitals'
import { schema } from '@blockly/db'
import { type SQL, sql } from 'drizzle-orm'

const { joins, serverReports: reports, serverVitals: vitals } = schema

/** The keys of `joins.detail` the player list's word is kept under, each an ISO moment. */
export const LISTED_AT = 'listedAt'
export const NOT_LISTED_AT = 'notListedAt'

const moment = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** What the server's player list said of a join, from its row's `detail`; null where it said nothing. */
export const listSaid = (detail: Record<string, unknown>) => ({
  listedAt: moment(detail[LISTED_AT]),
  notListedAt: moment(detail[NOT_LISTED_AT]),
})

const said = (key: string): SQL => sql`(${joins.detail} ->> ${key})`

/** Its server's player list showed the player. */
export const listed: SQL = sql`${said(LISTED_AT)} is not null`

/** In the world, by the reporter's word or the list's. */
export const gotIn: SQL = sql`(${joins.inWorldAt} is not null or ${listed})`

/** Who reads a server's ticks where its reporter doesn't sample them. */
const CONSOLE: VitalsSource = 'console'

/**
 * The join's server has a reporter: it told of its boot, and the server's ticks aren't read over
 * its console instead, which happens only where no reporter samples them
 * (`vitals/console-samples.ts`). The boot report alone outlives the plugin: a server that left
 * Paper, took a modpack or booted after `JOIN_REPORTER` stopped placing it keeps the report of the
 * boot before. Its newest sample decides, so the one console reading a wake may take before the
 * reporter's first sample passes within the minute. A server too old for `tick query` leaves no
 * console sample, and is read by its boot report alone.
 */
export const reporting: SQL = sql`(exists (select 1 from ${reports} where ${reports.serverId} = ${joins.serverId})
  and coalesce((select ${vitals.source} from ${vitals} where ${vitals.serverId} = ${joins.serverId}
    order by ${vitals.at} desc limit 1), '') <> ${CONSOLE})`

/**
 * A join that didn't get in, where that is known: turned away, with why; never handed to its
 * server; or handed over and not in the world by the word of whoever could tell. That is the
 * reporter, where it told of the join or its server has one, since a reporter tells of every
 * login. And it is the player list, once the join has ended, where a reading a minute or more
 * after the handing over didn't show the player: only its end says the join was still open when
 * the list was read (`player-list.ts`). A join handed to a server with no reporter that ended
 * before any such reading is left out. A login the game refused and a short visit look the same
 * from the edge there, so calling it stopped short would list every quick visit on a vanilla or
 * modded server, and calling it in the world would hide every refused login.
 */
export const stoppedShort: SQL = sql`(${joins.kind} = 'join' and (
  ${joins.leftReason} like 'refused:%'
  or (not ${gotIn} and (
    ${joins.handedAt} is null
    or ${joins.serverSide} = 'reported'
    or (${joins.leftAt} is not null and ${said(NOT_LISTED_AT)} is not null)
    or ${reporting}
  ))
))`
