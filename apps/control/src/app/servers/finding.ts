// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server as an operator names it: by what a player says, not only its id. Its id, its slug, the
 * address players join (`v0idworld.play.cubepals.com`, whose first label is the slug), or its name
 * in any case. Servers purged for good are never found. For the operators' API (`/ops/v1/servers/find`)
 * and every `ops.ts` command that takes a server.
 */
import { type Queryable, schema } from '@blockly/db'
import { and, eq, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'

const { minecraftServers: servers, users } = schema

/** A server found, with whose it is. */
export interface FoundServer {
  id: string
  slug: string
  name: string
  status: string
  owner: string
}

export class ServerFinder {
  readonly #db: Queryable

  constructor(db: Queryable) {
    this.#db = db
  }

  /** Every server `ref` names, newest first: one where it names one, several where names are shared. */
  async find(ref: string): Promise<FoundServer[]> {
    const given = ref.trim()
    if (given === '') return []
    // An address's first label is its slug: `steve.play.cubepals.com`, or `steve.play.cubepals.com:25565`.
    const label = given.toLowerCase().split(/[.:]/)[0] ?? ''
    const byId = z.uuid().safeParse(given).success ? [eq(servers.id, given)] : []
    return this.#db
      .select({
        id: servers.id,
        slug: servers.slug,
        name: servers.name,
        status: servers.status,
        owner: users.email,
      })
      .from(servers)
      .innerJoin(users, eq(users.id, servers.ownerId))
      .where(
        and(
          ne(servers.status, 'purged'),
          or(...byId, eq(servers.slug, label), sql`lower(${servers.name}) = ${given.toLowerCase()}`),
        ),
      )
      .orderBy(sql`${servers.createdAt} desc`)
      .limit(20)
  }
}
