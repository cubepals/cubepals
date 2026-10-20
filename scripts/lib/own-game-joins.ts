// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The staging check's joins into one of Cubepals' own games, timed from logging in to being in the
 * world: on a server running as Cubepals runs its own (marked official) with account checks off,
 * awake, then asleep and woken by the join. Either past the limit fails the check.
 *
 * Not for the client itself (`into-world.ts`), or for anything else of the journey.
 */
import { randomUUID } from 'node:crypto'
import { seconds } from './check-progress.ts'
import { intoWorld } from './into-world.ts'
import type { Edge } from './minecraft.ts'
import type { Api } from './people.ts'

/**
 * The longest a player may wait between logging in and being in the world, awake or woken by
 * their join. Measured on staging at under 1.2 s, apart from the first join after a boot; a join
 * held on a prompt, as by a resource pack offered while joining, never gets there.
 */
const IN_WORLD_LIMIT_MS = 3_000

/** As much of the staging check's journey as these joins use. */
interface Joiner {
  api: Api
  server: { id: string }
  address(): string
  timed(what: string, ms: number): string
  // biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as the journey reads it
  waitFor(done: (view: any) => boolean, what: string, limitSeconds: number): Promise<unknown>
}

/** Both joins, after marking the server official through `sql`; what they took, in words. */
export async function ownGameJoins(j: Joiner, edge: Edge, sql: (statement: string) => Promise<string>) {
  // Official, as `ops.ts official on` marks Cubepals' own; the change below starts it again as one.
  await sql(
    `insert into public_listings (server_id, official) values ('${j.server.id}', true) on conflict (server_id) do update set official = true`,
  )
  const { version } = await j.api('servers.get', { serverId: j.server.id }, 'GET')
  await j.api('servers.changeAuthentication', {
    serverId: j.server.id,
    requestId: randomUUID(),
    version,
    onlineMode: false,
  })
  await j.waitFor((v) => v.status === 'running' && v.activeOperation === null, 'started again', 600)
  const timed = async (what: string) => {
    const { loggedInMs, inWorldMs } = await intoWorld(edge, j.address(), 'StagingCheck')
    const took = inWorldMs - loggedInMs
    if (took > IN_WORLD_LIMIT_MS)
      throw new Error(
        `${what}: in the world ${seconds(took)} after logging in, past ${seconds(IN_WORLD_LIMIT_MS)}`,
      )
    return j.timed(`in the world after logging in, ${what}`, took)
  }
  // The first join after a boot is the slowest, and only has to get there.
  await intoWorld(edge, j.address(), 'StagingCheck')
  const awake = await timed('awake')
  await j.api('servers.stop', { serverId: j.server.id, requestId: randomUUID() })
  await j.waitFor((v) => v.status === 'stopped' && v.activeOperation === null, 'went to sleep', 300)
  return `in the world ${awake} after logging in awake, ${await timed('woken by the join')} woken by the join`
}
