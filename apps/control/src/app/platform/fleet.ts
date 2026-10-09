import type { FleetPage, FleetServerView } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { and, count, desc, eq, gt, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { isMemoryTier, memoryMb, sizeLabel } from '../../domain/server/size.ts'
import type { Actor } from '../actor.ts'
import { NotFound } from '../errors.ts'
import { type RuntimeHandle, type RuntimeTags, runtimeKey } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'

const servers = schema.minecraftServers
const users = schema.users
const standing = schema.accountStanding
const runtimes = schema.serverRuntimes
const intervals = schema.powerIntervals

/** A server id, with or without its dashes, anywhere in what was typed: a provider's name for it too. */
const SERVER_ID = /(?<![0-9a-f])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/

/**
 * The servers as an operator finds them (docs/operator-view.md): whose each is, what the provider calls
 * it and what it costs there, beside the tags that let the provider's own console say the same.
 * A provider names what it made once, while a server's name and owner's address change, so the
 * tags are written again whenever they differ, and the list here reads the handle every time.
 */
export class Fleet {
  readonly #db: Db
  readonly #runtime: Runtimes

  constructor(deps: { db: Db; runtime: Runtimes }) {
    this.#db = deps.db
    this.#runtime = deps.runtime
  }

  /**
   * `provider-tags`: every server's owner, name and plan written where the provider lists its
   * compute. The runtime writes only what changed, so this is the backfill as well.
   */
  async tag(): Promise<number> {
    const rows = await this.#db
      .select({ id: servers.id, name: servers.name, email: users.email, plan: standing.plan })
      .from(servers)
      .innerJoin(users, eq(users.id, servers.ownerId))
      .leftJoin(standing, eq(standing.userId, servers.ownerId))
      .where(ne(servers.status, 'purged'))
    return this.#runtime.tag(
      new Map(
        rows.map((row): [ReturnType<typeof runtimeKey>, RuntimeTags] => [
          runtimeKey(row.id),
          { owner: row.email, name: row.name, plan: row.plan ?? 'free' },
        ]),
      ),
    )
  }

  /**
   * Servers found by their name, address or id, a provider's name for them, or their owner's
   * email or name; newest first. This month's cost is the provider's list prices for the hours
   * each ran, at the size it ran at, and for the storage it holds, counted from the month's start.
   */
  async list(
    actor: Actor,
    query: { search: string; offset: number; limit: number },
    now = new Date(),
  ): Promise<FleetPage> {
    if (actor.kind !== 'admin') throw new NotFound('Servers')
    const text = query.search.trim()
    const hex = text.toLowerCase().match(SERVER_ID)?.[0].replace(/-/g, '')
    const match = and(
      ne(servers.status, 'purged'),
      text
        ? or(
            ilike(servers.name, `%${text}%`),
            ilike(servers.slug, `%${text}%`),
            ilike(users.email, `%${text}%`),
            ilike(users.name, `%${text}%`),
            hex === undefined
              ? undefined
              : eq(
                  servers.id,
                  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
                ),
          )
        : undefined,
    )
    const [total] = await this.#db
      .select({ n: count() })
      .from(servers)
      .innerJoin(users, eq(users.id, servers.ownerId))
      .where(match)
    const found = await this.#db
      .select({ server: servers, user: users, plan: standing.plan, runtime: runtimes })
      .from(servers)
      .innerJoin(users, eq(users.id, servers.ownerId))
      .leftJoin(standing, eq(standing.userId, servers.ownerId))
      .leftJoin(runtimes, eq(runtimes.serverId, servers.id))
      .where(match)
      .orderBy(desc(servers.createdAt))
      .offset(query.offset)
      .limit(query.limit)

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const monthSoFar = (now.getTime() - monthStart.getTime()) / (nextMonth.getTime() - monthStart.getTime())
    const ids = found.map((row) => row.server.id)
    const ran =
      ids.length === 0
        ? []
        : await this.#db
            .select({
              serverId: intervals.serverId,
              memoryTier: intervals.memoryTier,
              hours: sql<string>`sum(extract(epoch from (least(coalesce(${intervals.stoppedAt}, ${now}), ${now}) - greatest(${intervals.startedAt}, ${monthStart})))) / 3600`,
            })
            .from(intervals)
            .where(
              and(
                inArray(intervals.serverId, ids),
                lt(intervals.startedAt, now),
                gt(sql`coalesce(${intervals.stoppedAt}, ${now})`, monthStart),
              ),
            )
            .groupBy(intervals.serverId, intervals.memoryTier)

    return {
      total: total?.n ?? 0,
      servers: found.map(({ server, user, plan, runtime }): FleetServerView => {
        const handle =
          runtime !== null && this.#runtime.runs(runtime.provider) && runtime.handle !== null
            ? (runtime.handle as RuntimeHandle)
            : null
        const storageGb = Math.max(entitlementsFor(plan ?? 'free').storage.startGb, runtime?.storageGb ?? 0)
        const runs = ran.filter((row) => row.serverId === server.id)
        const hours = runs.reduce((sum, row) => sum + Number(row.hours), 0)
        const priced = (size: string) =>
          handle === null || !isMemoryTier(size)
            ? null
            : this.#runtime.prices(handle, { memoryMb: memoryMb(size), storageGb })
        const current = priced(server.memoryTier)
        const ranCents = runs.reduce(
          (sum, row) =>
            sum + Number(row.hours) * ((priced(row.memoryTier) ?? current)?.runningHourCents ?? 0),
          0,
        )
        // A resting world holds no storage at the provider.
        const heldCents = server.status === 'stored' ? 0 : monthSoFar * (current?.storageMonthCents ?? 0)
        const location = handle === null ? null : this.#runtime.locate(handle)
        return {
          id: server.id,
          name: server.name,
          slug: server.slug,
          status: server.status,
          deleted: server.deletedAt !== null,
          size: isMemoryTier(server.memoryTier) ? sizeLabel(server.memoryTier) : server.memoryTier,
          owner: { userId: user.id, email: user.email, name: user.name, plan: plan ?? 'free' },
          provider: location === null ? null : { names: [...location.names], link: location.link },
          runtime:
            runtime === null
              ? null
              : {
                  provider: runtime.provider,
                  runs: this.#runtime.runs(runtime.provider),
                  moveTo: runtime.moveTo,
                },
          month: {
            hours: Math.round(hours * 10) / 10,
            costCents: current === null ? null : Math.round(ranCents + heldCents),
          },
        }
      }),
    }
  }
}
