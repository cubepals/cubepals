// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a sweep over many servers reads of them, in one read rather than one each and only what it
 * looks at: where each runs and what was last seen of it, without the configuration it was given;
 * and, for the relocation sweep, each one's status, region and what its failure was in. Not for
 * one server's binding or row (`servers/persistence.ts`).
 */
import { type Queryable, schema } from '@blockly/db'
import { inArray, sql } from 'drizzle-orm'
import type { ServerStatus } from '../../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { NotFound } from '../../errors.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import { findServer, type RuntimeBinding } from '../../servers/persistence.ts'

const { serverRuntimes: runtimes, minecraftServers: servers } = schema

/** Of a server, what the relocation sweep decides on before it reads the whole of one it moves. */
export interface SweptServer {
  id: string
  status: ServerStatus
  regionKey: string
  /** What its failure happened during, where it failed. */
  failedDuring: string | null
}

/** The servers in each of `statuses`, those in the first, then the next, and on, in one read. */
export async function sweptServers(q: Queryable, statuses: readonly ServerStatus[]): Promise<SweptServer[]> {
  const rows = await q
    .select({
      id: servers.id,
      status: servers.status,
      regionKey: servers.regionKey,
      failedDuring: sql<string | null>`${servers.failure}->>'during'`,
    })
    .from(servers)
    .where(inArray(servers.status, [...statuses]))
  return statuses.flatMap((status) => rows.filter((s) => s.status === status))
}

/** Of a server's binding, where it runs and what was last seen of it: the configuration it was given aside. */
type Placement = Pick<RuntimeBinding, 'serverId' | 'provider' | 'handle' | 'foreign' | 'observed' | 'moveTo'>

/**
 * The placements of `serverIds`, in one read, for a sweep over many servers: a lookup that throws
 * for a server with no binding, as `loadRuntime` does.
 */
export async function placementsOf(
  q: Queryable,
  serverIds: readonly string[],
  providers: readonly string[],
): Promise<(serverId: string) => Placement> {
  const rows =
    serverIds.length === 0
      ? []
      : await q
          .select({
            serverId: runtimes.serverId,
            provider: runtimes.provider,
            handle: runtimes.handle,
            observed: runtimes.observed,
            moveTo: runtimes.moveTo,
          })
          .from(runtimes)
          .where(inArray(runtimes.serverId, [...serverIds]))
  const placements = new Map(
    rows.map((row) => {
      const foreign = !providers.includes(row.provider)
      return [
        row.serverId,
        { ...row, handle: foreign ? null : (row.handle as RuntimeHandle | null), foreign },
      ]
    }),
  )
  return (serverId) => {
    const placement = placements.get(serverId)
    if (placement === undefined) throw new Error(`Server ${serverId} has no runtime binding`)
    return placement
  }
}

/**
 * The spec digest each of `serverIds` last had applied (its drift digest where it has one), with
 * its handle, in one read: what the drift sweep compares, without the rest of what was applied.
 * Null for a server never applied; a server with no binding has none here.
 */
export async function appliedDigests(
  q: Queryable,
  serverIds: readonly string[],
  providers: readonly string[],
): Promise<Map<string, { handle: RuntimeHandle | null; digest: string | null }>> {
  if (serverIds.length === 0) return new Map()
  const rows = await q
    .select({
      serverId: runtimes.serverId,
      provider: runtimes.provider,
      handle: runtimes.handle,
      digest: sql<
        string | null
      >`coalesce(${runtimes.applied}->>'driftDigest', ${runtimes.applied}->>'specDigest')`,
    })
    .from(runtimes)
    .where(inArray(runtimes.serverId, [...serverIds]))
  return new Map(
    rows.map((row) => [
      row.serverId,
      {
        handle: providers.includes(row.provider) ? (row.handle as RuntimeHandle | null) : null,
        digest: row.digest,
      },
    ]),
  )
}

/** The whole of a server the sweep moves; one gone since it was listed is not found. */
export async function wholeServer(q: Queryable, serverId: string): Promise<MinecraftServer> {
  const server = await findServer(q, serverId)
  if (server === null) throw new NotFound('Server')
  return server
}
