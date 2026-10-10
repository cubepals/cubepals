import type { FleetPage, FleetRegionView, FleetServerView } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { and, desc, eq, gt, ilike, inArray, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { isMemoryTier, memoryMb, sizeLabel } from '../../domain/server/size.ts'
import { formatJoinAddress } from '../../minecraft/address.ts'
import type { Actor } from '../actor.ts'
import { NotFound } from '../errors.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import { type RuntimeHandle, type RuntimeTags, runtimeKey } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'

const servers = schema.minecraftServers
const users = schema.users
const standing = schema.accountStanding
const runtimes = schema.serverRuntimes
const intervals = schema.powerIntervals
const presence = schema.serverPresence
const activity = schema.serverActivity

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
  readonly #addressing: PlayAddressing

  constructor(deps: { db: Db; runtime: Runtimes; addressing: PlayAddressing }) {
    this.#db = deps.db
    this.#runtime = deps.runtime
    this.#addressing = deps.addressing
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
   * email or name; newest first, with every one found added up by where it runs. This month's
   * cost is the provider's list prices for the hours each ran, at the size it ran at, and for the
   * storage it holds, counted from the month's start.
   */
  async list(
    actor: Actor,
    query: { search: string; offset: number; limit: number },
    now = new Date(),
  ): Promise<FleetPage> {
    if (actor.kind !== 'admin') throw new NotFound('Servers')
    const match = matching(query.search)
    const found = await this.#db
      .select({
        id: servers.id,
        name: servers.name,
        slug: servers.slug,
        status: servers.status,
        memoryTier: servers.memoryTier,
        regionKey: servers.regionKey,
        deletedAt: servers.deletedAt,
        userId: users.id,
        email: users.email,
        userName: users.name,
        plan: standing.plan,
        provider: runtimes.provider,
        handle: runtimes.handle,
        placementRegionKey: runtimes.placementRegionKey,
        storageGb: runtimes.storageGb,
        moveTo: runtimes.moveTo,
        lastPlayedAt: activity.lastPlayerAt,
        online: sql<number>`(select count(*)::int from ${presence} where ${presence.serverId} = ${servers.id})`,
      })
      .from(servers)
      .innerJoin(users, eq(users.id, servers.ownerId))
      .leftJoin(standing, eq(standing.userId, servers.ownerId))
      .leftJoin(runtimes, eq(runtimes.serverId, servers.id))
      .leftJoin(activity, eq(activity.serverId, servers.id))
      .where(match)
      .orderBy(desc(servers.createdAt))
    const ran = await this.#ranThisMonth(match, now)
    const views = found.map((row) => this.#view(row, ran.get(row.id) ?? [], now))
    return {
      total: views.length,
      servers: views.slice(query.offset, query.offset + query.limit),
      regions: regionsOf(views),
    }
  }

  /** The hours each server found ran this month, by the size it ran at. */
  async #ranThisMonth(match: SQL | undefined, now: Date): Promise<Map<string, Ran[]>> {
    const monthStart = startOfMonth(now)
    const found = this.#db
      .select({ id: servers.id })
      .from(servers)
      .innerJoin(users, eq(users.id, servers.ownerId))
      .where(match)
    const rows = await this.#db
      .select({
        serverId: intervals.serverId,
        memoryTier: intervals.memoryTier,
        hours: sql<string>`sum(extract(epoch from (least(coalesce(${intervals.stoppedAt}, ${now}), ${now}) - greatest(${intervals.startedAt}, ${monthStart})))) / 3600`,
      })
      .from(intervals)
      .where(
        and(
          inArray(intervals.serverId, found),
          lt(intervals.startedAt, now),
          gt(sql`coalesce(${intervals.stoppedAt}, ${now})`, monthStart),
        ),
      )
      .groupBy(intervals.serverId, intervals.memoryTier)
    const byServer = new Map<string, Ran[]>()
    for (const row of rows) {
      const runs = byServer.get(row.serverId) ?? []
      runs.push({ memoryTier: row.memoryTier, hours: Number(row.hours) })
      byServer.set(row.serverId, runs)
    }
    return byServer
  }

  #view(row: Found, runs: readonly Ran[], now: Date): FleetServerView {
    const handle =
      row.provider !== null && this.#runtime.runs(row.provider) && row.handle !== null
        ? (row.handle as RuntimeHandle)
        : null
    const plan = row.plan ?? 'free'
    const storageGb = Math.max(entitlementsFor(plan).storage.startGb, row.storageGb ?? 0)
    const hours = runs.reduce((sum, run) => sum + run.hours, 0)
    const priced = (size: string) =>
      handle === null || !isMemoryTier(size)
        ? null
        : this.#runtime.prices(handle, { memoryMb: memoryMb(size), storageGb })
    const current = priced(row.memoryTier)
    const ranCents = runs.reduce(
      (sum, run) => sum + run.hours * ((priced(run.memoryTier) ?? current)?.runningHourCents ?? 0),
      0,
    )
    const monthStart = startOfMonth(now)
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const monthSoFar = (now.getTime() - monthStart.getTime()) / (nextMonth.getTime() - monthStart.getTime())
    // A resting world holds no storage at the provider.
    const heldCents = row.status === 'stored' ? 0 : monthSoFar * (current?.storageMonthCents ?? 0)
    const location = handle === null ? null : this.#runtime.locate(handle)
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      address: formatJoinAddress(this.#addressing.primary(row.slug)),
      status: row.status,
      deleted: row.deletedAt !== null,
      size: isMemoryTier(row.memoryTier) ? sizeLabel(row.memoryTier) : row.memoryTier,
      owner: { userId: row.userId, email: row.email, name: row.userName, plan },
      region:
        location?.names.find((name) => name.label === 'Region')?.value ??
        row.placementRegionKey ??
        row.regionKey,
      online: row.status === 'running' ? row.online : 0,
      lastPlayedAt: row.lastPlayedAt?.toISOString() ?? null,
      provider: location === null ? null : { names: [...location.names], link: location.link },
      runtime:
        row.provider === null
          ? null
          : { provider: row.provider, runs: this.#runtime.runs(row.provider), moveTo: row.moveTo },
      month: {
        hours: Math.round(hours * 10) / 10,
        costCents: current === null ? null : Math.round(ranCents + heldCents),
      },
    }
  }
}

/** One server as the list reads it, before it is priced. */
interface Found {
  id: string
  name: string
  slug: string
  status: string
  memoryTier: string
  regionKey: string
  deletedAt: Date | null
  userId: string
  email: string
  userName: string
  plan: string | null
  provider: string | null
  handle: string | null
  placementRegionKey: string | null
  storageGb: number | null
  moveTo: string | null
  lastPlayedAt: Date | null
  online: number
}

/** Hours a server ran this month at one size. */
interface Ran {
  memoryTier: string
  hours: number
}

const startOfMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

/** What a search matches: a server's name, address or id, or its owner's email or name. */
function matching(search: string): SQL | undefined {
  const text = search.trim()
  const hex = text.toLowerCase().match(SERVER_ID)?.[0].replace(/-/g, '')
  return and(
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
}

/**
 * Servers added up by where they run, one runtime's one region: how many are in each status, and
 * their month together. The place with the most servers comes first.
 */
function regionsOf(views: readonly FleetServerView[]): FleetRegionView[] {
  const regions = new Map<string, FleetRegionView>()
  for (const view of views) {
    const provider = view.runtime?.provider ?? null
    const key = JSON.stringify([provider, view.region])
    const region = regions.get(key) ?? {
      provider,
      region: view.region,
      servers: 0,
      states: {},
      month: { hours: 0, costCents: null },
    }
    const state = view.deleted ? 'deleted' : view.status
    region.servers += 1
    region.states[state] = (region.states[state] ?? 0) + 1
    region.month.hours = Math.round((region.month.hours + view.month.hours) * 10) / 10
    if (view.month.costCents !== null)
      region.month.costCents = (region.month.costCents ?? 0) + view.month.costCents
    regions.set(key, region)
  }
  return [...regions.values()].sort(
    (a, b) =>
      b.servers - a.servers ||
      (a.provider ?? '').localeCompare(b.provider ?? '') ||
      a.region.localeCompare(b.region),
  )
}
