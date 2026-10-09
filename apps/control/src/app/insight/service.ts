/**
 * What reaches the operator through PostHog: the funnel events kept in `record.ts`, sent by
 * the worker; a line of feedback from the sidebar; and "How's it going?" after a good moment, at
 * most once a fortnight. Each is about an account by its id; only feedback carries the sender's
 * email, so the operator can write back. With no analytics service, nothing here sends anything.
 */
import type { InsightSentView, MomentAskView, MomentKey } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm'
import { actionsSince, loadStanding, lockAccountActions } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { Insight } from '../ports/insight.ts'

/** PostHog's "Feedback" survey and its one open question, "What's on your mind?". */
export const FEEDBACK_SURVEY = {
  id: '01a1184e-4954-0000-fdd6-4bd54692864c',
  name: 'Feedback',
  question: { id: '8d23132f-4ed4-4e93-93ff-18a64ecd8d25', text: 'What’s on your mind?' },
} as const

/** PostHog's "Good moment" survey: a rating, then an optional line. */
export const MOMENT_SURVEY = {
  id: '01a1184e-52af-0000-f127-5b619e0426c5',
  name: 'Good moment',
  rating: { id: 'd3741c10-8b96-4f98-8d54-ff2b164f4164', text: 'How’s it going?' },
  more: { id: 'c8667272-17ef-4c21-b1d4-8eac008ed33f', text: 'Anything to add?' },
} as const

/** Lines of feedback one account sends a minute: a person writing, not a script. */
const FEEDBACK_PER_MINUTE = 3
/** The most kept events one pass of the worker sends. */
const BATCH = 200
/** One question a fortnight at most, about a moment no older than that. */
const SPACING_MS = 14 * 86_400_000
/** A question shown and left unanswered is shown again, on the next page, for this long. */
const STILL_ASKING_MS = 86_400_000
/** A checkout started this recently may still be under way. */
const PAYING_MS = 3_600_000

export class InsightService {
  readonly #db: Db
  readonly #insight: Insight | null

  constructor(deps: { db: Db; insight: Insight | null }) {
    this.#db = deps.db
    this.#insight = deps.insight
  }

  /** An error a request ended in, with its route and request id; nothing when PostHog is off. */
  report(error: unknown, context: { distinctId?: string; properties: Record<string, string> }): void {
    this.#insight?.exception(error, context)
  }

  /** The worker's pass: kept events not yet sent, oldest first, each marked once PostHog took it. */
  async drain(): Promise<number> {
    const insight = this.#insight
    if (insight === null) return 0
    const events = schema.insightEvents
    const waiting = await this.#db
      .select()
      .from(events)
      .where(isNull(events.sentAt))
      .orderBy(asc(events.at))
      .limit(BATCH)
    let sent = 0
    for (const row of waiting) {
      const took = await insight.send({
        distinctId: row.userId,
        event: row.event,
        properties: row.properties,
        at: row.at,
      })
      // The service is away: the rest wait for the next pass, in order.
      if (!took) break
      await this.#db.update(events).set({ sentAt: new Date() }).where(eq(events.id, row.id))
      sent++
    }
    return sent
  }

  /**
   * A line of feedback, with who sent it and from where: their email so they can be answered, their
   * plan, the page they were on and the app's version. Counted per account like other writes,
   * under the account's own lock, by the audit entries each one leaves.
   */
  async feedback(
    actor: UserActor,
    input: { text: string; page: string; version: string },
  ): Promise<InsightSentView> {
    const { email, plan } = await this.#db.transaction(async (tx) => {
      await lockAccountActions(tx, actor.userId)
      const aMinuteAgo = new Date(Date.now() - 60_000)
      if (
        (await actionsSince(tx, `user:${actor.userId}`, 'insight.feedback_sent', aMinuteAgo)) >=
        FEEDBACK_PER_MINUTE
      )
        throw new AppError('rate_limited', 'That is a lot at once. Wait a minute, then send more.')
      // The count's own entry: that it was sent, never what it said.
      await tx.insert(schema.auditLog).values({
        actor: `user:${actor.userId}`,
        action: 'insight.feedback_sent',
        subjectType: 'account',
        subjectId: actor.userId,
        data: {},
      })
      const [user] = await tx
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, actor.userId))
      return { email: user?.email ?? '', plan: (await loadStanding(tx, actor.userId)).plan }
    })
    if (this.#insight === null) return { sent: false }
    const sent = await this.#insight.send({
      distinctId: actor.userId,
      event: 'survey sent',
      properties: {
        $survey_id: FEEDBACK_SURVEY.id,
        $survey_name: FEEDBACK_SURVEY.name,
        [`$survey_response_${FEEDBACK_SURVEY.question.id}`]: input.text,
        $survey_questions: [
          { id: FEEDBACK_SURVEY.question.id, question: FEEDBACK_SURVEY.question.text, response: input.text },
        ],
        $survey_completed: true,
        email,
        plan,
        page: input.page,
        app_version: input.version,
      },
    })
    return { sent }
  }

  /**
   * The question to ask now, if any: one shown in the last day and not yet answered or put away,
   * or else the newest moment of the last fortnight, when none was asked in it. Never while the
   * person may be making a server or paying.
   */
  async ask(actor: UserActor, busy: boolean): Promise<MomentAskView | null> {
    if (this.#insight === null || busy || (await this.#midway(actor.userId))) return null
    const asks = schema.insightAsks
    const now = Date.now()
    const open = and(eq(asks.userId, actor.userId), isNull(asks.answeredAt), isNull(asks.dismissedAt))
    const [still] = await this.#db
      .select()
      .from(asks)
      .where(and(open, gt(asks.shownAt, new Date(now - STILL_ASKING_MS))))
      .limit(1)
    if (still !== undefined) return viewOf(still)
    const [recent] = await this.#db
      .select({ moment: asks.moment })
      .from(asks)
      .where(and(eq(asks.userId, actor.userId), gt(asks.shownAt, new Date(now - SPACING_MS))))
      .limit(1)
    if (recent !== undefined) return null
    const [next] = await this.#db
      .select()
      .from(asks)
      .where(and(open, isNull(asks.shownAt), gt(asks.at, new Date(now - SPACING_MS))))
      .orderBy(desc(asks.at))
      .limit(1)
    if (next === undefined) return null
    const shown = await this.#db
      .update(asks)
      .set({ shownAt: new Date(now) })
      .where(and(eq(asks.userId, actor.userId), eq(asks.moment, next.moment), isNull(asks.shownAt)))
      .returning({ moment: asks.moment })
    if (shown.length > 0) this.#survey(actor.userId, 'survey shown', next.moment)
    return viewOf(next)
  }

  /** "Good" or "Not great", and a line if they wrote one: the question is done. */
  async answer(
    actor: UserActor,
    input: {
      moment: MomentKey
      rating: 'Good' | 'Not great'
      text?: string | undefined
      page: string
      version: string
    },
  ): Promise<InsightSentView> {
    const asks = schema.insightAsks
    const answered = await this.#db
      .update(asks)
      .set({ answeredAt: new Date() })
      .where(
        and(
          eq(asks.userId, actor.userId),
          eq(asks.moment, input.moment),
          isNotNull(asks.shownAt),
          isNull(asks.answeredAt),
          isNull(asks.dismissedAt),
        ),
      )
      .returning({ moment: asks.moment })
    if (answered.length === 0 || this.#insight === null) return { sent: false }
    const more = input.text === undefined || input.text === '' ? null : input.text
    const sent = await this.#insight.send({
      distinctId: actor.userId,
      event: 'survey sent',
      properties: {
        $survey_id: MOMENT_SURVEY.id,
        $survey_name: MOMENT_SURVEY.name,
        [`$survey_response_${MOMENT_SURVEY.rating.id}`]: input.rating,
        ...(more === null ? {} : { [`$survey_response_${MOMENT_SURVEY.more.id}`]: more }),
        $survey_questions: [
          { id: MOMENT_SURVEY.rating.id, question: MOMENT_SURVEY.rating.text, response: input.rating },
          { id: MOMENT_SURVEY.more.id, question: MOMENT_SURVEY.more.text, response: more },
        ],
        $survey_completed: true,
        moment: input.moment,
        page: input.page,
        app_version: input.version,
      },
    })
    return { sent }
  }

  /** Put away: that moment is never asked about again. */
  async dismiss(actor: UserActor, moment: MomentKey): Promise<void> {
    const asks = schema.insightAsks
    const dismissed = await this.#db
      .update(asks)
      .set({ dismissedAt: new Date() })
      .where(
        and(
          eq(asks.userId, actor.userId),
          eq(asks.moment, moment),
          isNull(asks.answeredAt),
          isNull(asks.dismissedAt),
        ),
      )
      .returning({ moment: asks.moment })
    if (dismissed.length > 0) this.#survey(actor.userId, 'survey dismissed', moment)
  }

  /** A server of theirs still being made, or a checkout started within the hour and not yet paid. */
  async #midway(userId: string): Promise<boolean> {
    const servers = schema.minecraftServers
    const [making] = await this.#db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.ownerId, userId), inArray(servers.status, ['provisioning'])))
      .limit(1)
    if (making !== undefined) return true
    const log = schema.auditLog
    const [started] = await this.#db
      .select({ at: log.at })
      .from(log)
      .where(
        and(
          eq(log.actor, `user:${userId}`),
          eq(log.action, 'billing.checkout_started'),
          gt(log.at, new Date(Date.now() - PAYING_MS)),
        ),
      )
      .orderBy(desc(log.at))
      .limit(1)
    if (started === undefined) return false
    // A checkout that went through has changed the plan since: they aren't paying any more.
    const [paid] = await this.#db
      .select({ id: log.id })
      .from(log)
      .where(and(eq(log.subjectId, userId), eq(log.action, 'account.plan_changed'), gt(log.at, started.at)))
      .limit(1)
    return paid === undefined
  }

  /** Shown or dismissed: sent in the background, since nobody waits on it. */
  #survey(userId: string, event: 'survey shown' | 'survey dismissed', moment: string): void {
    this.#insight?.capture({
      distinctId: userId,
      event,
      properties: { $survey_id: MOMENT_SURVEY.id, $survey_name: MOMENT_SURVEY.name, moment },
    })
  }
}

function viewOf(row: typeof schema.insightAsks.$inferSelect): MomentAskView {
  return {
    moment: row.moment as MomentKey,
    at: row.at.toISOString(),
    serverName: row.detail.serverName,
    player: row.detail.player ?? null,
  }
}
