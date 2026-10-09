import { type Queryable, type RuntimeConsideredJson, schema } from '@blockly/db'
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { ServerStatus } from '../../domain/server/lifecycle.ts'
import type { PlacementRule } from './placement.ts'

const rules = schema.runtimeRules
const decisions = schema.runtimeDecisions
const bindings = schema.serverRuntimes

type DecisionKind = (typeof schema.runtimeDecisionKind.enumValues)[number]

export interface RuntimeDecision {
  id: string
  serverId: string
  kind: DecisionKind
  provider: string
  fromProvider: string | null
  ruleId: string | null
  reason: string
  considered: RuntimeConsideredJson[]
  decidedBy: string
  at: Date
}

export interface StoredRule extends PlacementRule {
  createdBy: string
  createdAt: Date
  updatedBy: string
  updatedAt: Date
}

/** Every rule, in the order placement reads them. */
export async function loadRules(q: Queryable): Promise<StoredRule[]> {
  return q.select().from(rules).orderBy(asc(rules.createdAt), asc(rules.id))
}

export async function loadRule(q: Queryable, id: string): Promise<StoredRule | null> {
  const [row] = await q.select().from(rules).where(eq(rules.id, id))
  return row ?? null
}

export async function insertRule(
  q: Queryable,
  rule: Omit<PlacementRule, 'id'>,
  by: string,
): Promise<StoredRule> {
  const [row] = await q
    .insert(rules)
    .values({
      ...rule,
      accounts: [...rule.accounts],
      regions: [...rule.regions],
      plans: [...rule.plans],
      createdBy: by,
      updatedBy: by,
    })
    .returning()
  if (!row) throw new Error('The rule was not saved')
  return row
}

export async function updateRule(
  q: Queryable,
  id: string,
  patch: Partial<Omit<PlacementRule, 'id' | 'provider'>>,
  by: string,
): Promise<StoredRule | null> {
  const [row] = await q
    .update(rules)
    .set({
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.percent === undefined ? {} : { percent: patch.percent }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      ...(patch.accounts === undefined ? {} : { accounts: [...patch.accounts] }),
      ...(patch.regions === undefined ? {} : { regions: [...patch.regions] }),
      ...(patch.plans === undefined ? {} : { plans: [...patch.plans] }),
      updatedBy: by,
      updatedAt: new Date(),
    })
    .where(eq(rules.id, id))
    .returning()
  return row ?? null
}

export async function recordDecision(
  q: Queryable,
  decision: Omit<RuntimeDecision, 'id' | 'at'>,
): Promise<void> {
  await q.insert(decisions).values(decision)
}

/** How a server was placed when it was made; null for one made before decisions were kept. */
export async function placedDecision(q: Queryable, serverId: string): Promise<RuntimeDecision | null> {
  const [row] = await q
    .select()
    .from(decisions)
    .where(and(eq(decisions.serverId, serverId), eq(decisions.kind, 'placed')))
    .orderBy(desc(decisions.at))
    .limit(1)
  return row ?? null
}

/** A server's decisions, newest first. */
export async function decisionsOf(q: Queryable, serverId: string, limit = 50): Promise<RuntimeDecision[]> {
  return q
    .select()
    .from(decisions)
    .where(eq(decisions.serverId, serverId))
    .orderBy(desc(decisions.at))
    .limit(limit)
}

export async function recentDecisions(q: Queryable, since: Date, limit = 200): Promise<RuntimeDecision[]> {
  return q
    .select()
    .from(decisions)
    .where(sql`${decisions.at} >= ${since}`)
    .orderBy(desc(decisions.at))
    .limit(limit)
}

/** The runtime an operator asked a server to move to, or null to stay. */
export async function setMoveTo(q: Queryable, serverId: string, to: string | null): Promise<void> {
  await q.update(bindings).set({ moveTo: to, updatedAt: new Date() }).where(eq(bindings.serverId, serverId))
}

/**
 * The server now lives on `provider` under `handle`. Only a move or a first start's fallback
 * changes a binding's runtime; nothing else ever writes it.
 */
export async function rebind(
  q: Queryable,
  serverId: string,
  provider: string,
  handle: string | null,
  regionKey?: string,
): Promise<void> {
  await q
    .update(bindings)
    .set({
      provider,
      handle,
      moveTo: null,
      ...(regionKey === undefined ? {} : { placementRegionKey: regionKey }),
      updatedAt: new Date(),
    })
    .where(eq(bindings.serverId, serverId))
}

/**
 * A binding that has never held anything moves from one runtime to another: the first start's
 * fallback. False when it holds something by now, or is on another runtime already.
 */
export async function switchUnstarted(
  q: Queryable,
  serverId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const switched = await q
    .update(bindings)
    .set({ provider: to, updatedAt: new Date() })
    .where(
      and(
        eq(bindings.serverId, serverId),
        eq(bindings.provider, from),
        isNull(bindings.handle),
        isNull(bindings.applied),
      ),
    )
    .returning({ serverId: bindings.serverId })
  return switched.length > 0
}

/** How many live servers each runtime holds. */
export async function serversByProvider(q: Queryable): Promise<Map<string, number>> {
  return boundExcept(q, ['deleted', 'purged'])
}

/**
 * How many servers hold compute on each runtime: what a provider's own limit counts, as Fly's
 * machine limit does. As in the platform's own count, a resting world holds none: it let its
 * machine go.
 */
export async function computeByProvider(q: Queryable): Promise<Map<string, number>> {
  return boundExcept(q, ['deleted', 'purged', 'stored'])
}

async function boundExcept(q: Queryable, statuses: readonly ServerStatus[]): Promise<Map<string, number>> {
  const rows = await q
    .select({ provider: bindings.provider, n: sql<number>`count(*)::int` })
    .from(bindings)
    .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, bindings.serverId))
    .where(notInArray(schema.minecraftServers.status, [...statuses]))
    .groupBy(bindings.provider)
  return new Map(rows.map((row) => [row.provider, row.n]))
}

/** The servers with a move asked for, and where to. */
export async function pendingMoves(
  q: Queryable,
): Promise<Array<{ serverId: string; from: string; to: string }>> {
  const rows = await q
    .select({ serverId: bindings.serverId, from: bindings.provider, to: bindings.moveTo })
    .from(bindings)
    .where(sql`${bindings.moveTo} IS NOT NULL`)
  return rows.flatMap((row) =>
    row.to === null ? [] : [{ serverId: row.serverId, from: row.from, to: row.to }],
  )
}

export async function usersByEmail(q: Queryable, emails: readonly string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map()
  const rows = await q
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(
      inArray(
        sql`lower(${schema.users.email})`,
        emails.map((e) => e.toLowerCase()),
      ),
    )
  return new Map(rows.map((row) => [row.email.toLowerCase(), row.id]))
}
