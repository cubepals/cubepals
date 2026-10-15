// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a sweep over many servers reads of their bindings, in one read rather than one each: where
 * each runs and what was last seen of it, without the configuration it was given. Not for one
 * server's binding (`servers/persistence.ts`).
 */
import { type Queryable, schema } from '@blockly/db'
import { inArray } from 'drizzle-orm'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { RuntimeBinding } from '../../servers/persistence.ts'

const runtimes = schema.serverRuntimes

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
