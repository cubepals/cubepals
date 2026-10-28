// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Puts a staging server to rest now, as the store sweep would once nobody had played on it for
 * weeks: its last play set back, then the sweep asked to run. For the staging check and the join
 * times, which then time what comes after; not for anything a player's server goes through.
 *
 * A store is called off while anything else is queued or under way for the server (`otherWork`,
 * `apps/control/src/app/operations/persistence.ts`), such as the backup and the archive a stop
 * leaves behind, and the hourly sweep would only try again the next hour. So each ask waits until
 * the server has no work open, and a store called off is asked for again, as the sweep itself
 * would at its next pass.
 */
import { SECOND_MS } from '@blockly/contracts/durations'

export interface RestNow {
  /** One statement on staging's database, its rows. */
  sql: (statement: string) => Promise<Record<string, unknown>[]>
  /** Asks the store sweep to run now. */
  sweep: () => Promise<void>
  serverId: string
  /** Days without play to set, past what any plan waits before a rest. */
  idleDays: number
  /** How long the whole of it may take. */
  limitMs: number
  /** Told why an ask didn't rest the server, before it asks again. */
  note?: (line: string) => void
}

const POLL_MS = 2 * SECOND_MS
const ASKS = 5
/** A sweep asked to run that hasn't started a store for the server in this long is asked again. */
const SWEEP_MS = 120 * SECOND_MS

/** What the database says of the server and its latest store since `since`. */
interface Seen {
  status: string
  open: number
  store: { status: string; error: string | null } | null
}

export async function restNow(r: RestNow): Promise<void> {
  const deadline = Date.now() + r.limitMs
  for (let ask = 1; ask <= ASKS; ask++) {
    await untilIdle(r, deadline)
    if ((await seen(r, null)).status === 'stored') return
    await r.sql(
      `update minecraft_servers set last_active_at = now() - interval '${r.idleDays} days' where id = '${r.serverId}'`,
    )
    const [row] = await r.sql('select now()::text as at')
    const since = String(row?.at)
    await r.sweep()
    const why = await outcome(r, since, deadline)
    if (why === null) return
    r.note?.(`not rested (ask ${ask} of ${ASKS}): ${why}`)
  }
  throw new Error(`never rested in ${ASKS} asks`)
}

async function seen(r: RestNow, since: string | null): Promise<Seen> {
  const [row] = await r.sql(
    `select s.status,
       (select count(*)::int from server_operations o where o.server_id = s.id and o.status in ('queued', 'running')) as open,
       (select json_build_object('status', o.status, 'error', o.error) from server_operations o
         where o.server_id = s.id and o.kind = 'store' and o.created_at >= ${since === null ? "'-infinity'" : `'${since}'`}::timestamptz
         order by o.created_at desc limit 1) as store
     from minecraft_servers s where s.id = '${r.serverId}'`,
  )
  if (row === undefined) throw new Error(`no server ${r.serverId}`)
  const store = typeof row.store === 'string' ? JSON.parse(row.store) : row.store
  return { status: String(row.status), open: Number(row.open), store: (store as Seen['store']) ?? null }
}

/** Until nothing is queued or under way for the server, background work included. */
async function untilIdle(r: RestNow, deadline: number): Promise<void> {
  while ((await seen(r, null)).open > 0) {
    if (Date.now() > deadline) throw new Error('its work never finished')
    await Bun.sleep(POLL_MS)
  }
}

/**
 * Null once the server rests; otherwise why the store asked for at `since` was called off. A store
 * that failed throws: the sweep tries one again only a day later, since what failed it seldom mends.
 */
async function outcome(r: RestNow, since: string, deadline: number): Promise<string | null> {
  const asked = Date.now()
  for (;;) {
    const now = await seen(r, since)
    const said = verdict(now, Date.now() - asked)
    if (said !== undefined) return said
    if (Date.now() > deadline)
      throw new Error(`never rested: ${now.status}, store ${now.store?.status ?? 'none'}`)
    await Bun.sleep(POLL_MS)
  }
}

/** What `now` says of an ask `waitedMs` old: rested (null), why not, or nothing yet (undefined). */
function verdict(now: Seen, waitedMs: number): string | null | undefined {
  if (now.status === 'stored' && now.open === 0) return null
  if (now.store?.status === 'failed')
    throw new Error(`its store failed: ${now.store.error ?? 'no reason given'}`)
  if (now.store?.status === 'cancelled') return now.store.error ?? 'its store was called off'
  if (now.store === null && waitedMs > SWEEP_MS) return 'the sweep started no store'
  return undefined
}
