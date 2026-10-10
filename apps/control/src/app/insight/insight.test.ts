/**
 * The funnel, feedback and the good-moment question end to end, against a stand-in for PostHog:
 * each event kept once where it happens and sent once by the worker's pass, feedback's exact
 * payload and pacing, and when the question is asked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { RecordedInsight } from '../../testing/insight.ts'
import type { UserActor } from '../actor.ts'
import type { BillingProvider } from '../ports/optional.ts'
import { FUNNEL } from './record.ts'
import { FEEDBACK_SURVEY, MOMENT_SURVEY } from './service.ts'

/** A billing provider that is never asked anything but whether a renewal failed. */
const billing: BillingProvider = {
  provider: 'test',
  checkoutUrl: async () => 'https://billing.test/checkout',
  portalUrl: async () => 'https://billing.test/portal',
  receive: async () => null,
  stateOf: async () => null,
  pastDueSince: async () => null,
  order: async () => null,
  reportUsage: async () => {},
  settleUrl: async () => 'https://billing.test/settle',
}

const WHERE = { page: '/servers', version: 'test-build' }

const posthog = new RecordedInsight()
let h: Harness

// One harness for the file, where there is a database: booting is the slow part.
beforeAll(async () => {
  if (hasDatabase) h = await startHarness({ capabilities: { archives: null, billing, insight: posthog } })
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

beforeEach(() => {
  posthog.reachable = true
})

/** Sends what is kept, as the worker does, and answers what this pass sent about `userId`. */
const sent = async (userId: string) => {
  const before = posthog.events.length
  await h.app.insight.drain()
  return posthog.events.slice(before).filter((e) => e.distinctId === userId)
}
/** An account with a moment noticed `daysAgo`, as `record.ts` keeps one. */
const withMoment = async (moment: string, daysAgo = 0, owner?: UserActor) => {
  const actor = owner ?? (await h.user())
  await h.db.insert(schema.insightAsks).values({
    userId: actor.userId,
    moment,
    detail: { serverName: 'Castle', player: 'Alex' },
    at: new Date(Date.now() - daysAgo * 86_400_000),
  })
  return actor
}
const running = async (owner: UserActor) => {
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return created
}
const stopped = async (owner: UserActor, id: string) => {
  await h.app.servers.stop(owner, id, randomUUID(), 'idle')
  await h.until(id, 'stopped')
  await h.settled(id)
}

// Each funnel event is kept once where it happens, in the transaction of what it describes.
describe.skipIf(!hasDatabase)('the funnel, for an account', () => {
  test('signed_up is kept once for an account, and sent once', async () => {
    const owner = await h.user()
    await h.app.accounts.opened(owner.userId)
    await h.app.accounts.opened(owner.userId)
    expect((await sent(owner.userId)).map((e) => e.event)).toEqual([FUNNEL.signedUp])
    expect(await sent(owner.userId)).toEqual([])
  })

  test('plan_upgraded comes from the provider’s webhook alone, once per plan, with the plan', async () => {
    const owner = await h.user()
    const state = {
      userId: owner.userId,
      externalCustomerId: 'customer-1',
      subscription: {
        externalSubscriptionId: `sub-${owner.userId}`,
        planKey: 'plus',
        status: 'active' as const,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        cancelAtPeriodEnd: false,
      },
    }
    // Coming back from checkout before the webhook: the plan is saved, but nothing confirmed it.
    await h.app.billing.syncSubscription(state, `user:${owner.userId}`, 'user')
    expect(await sent(owner.userId)).toEqual([])
    await h.app.billing.syncSubscription(state, 'system:billing', 'webhook')
    await h.app.billing.syncSubscription(state, 'system:billing', 'webhook')
    const events = await sent(owner.userId)
    expect(events.map((e) => [e.event, e.properties])).toEqual([[FUNNEL.planUpgraded, { plan: 'plus' }]])
  })

  test('kept events wait while PostHog is away, then go in order, each once', async () => {
    const owner = await h.user()
    await h.app.accounts.opened(owner.userId)
    posthog.reachable = false
    expect(await sent(owner.userId)).toEqual([])
    posthog.reachable = true
    expect((await sent(owner.userId)).map((e) => e.event)).toEqual([FUNNEL.signedUp])
    const [row] = await h.db
      .select()
      .from(schema.insightEvents)
      .where(
        and(eq(schema.insightEvents.userId, owner.userId), eq(schema.insightEvents.event, FUNNEL.signedUp)),
      )
    expect(row?.sentAt).toBeInstanceOf(Date)
  })
})

describe.skipIf(!hasDatabase)('the funnel, for servers and their players', () => {
  test('a server is created once and first started once, however often it starts again', async () => {
    const owner = await h.user('Steve', 'plus')
    const { id } = await running(owner)
    await stopped(owner, id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const events = await sent(owner.userId)
    expect(events.map((e) => e.event).sort()).toEqual([FUNNEL.serverCreated, FUNNEL.serverFirstStarted])
    expect(events.find((e) => e.event === FUNNEL.serverCreated)?.properties).toMatchObject({ from: 'direct' })
    // A second server is its own.
    await running(owner)
    expect((await sent(owner.userId)).map((e) => e.event).sort()).toEqual([
      FUNNEL.serverCreated,
      FUNNEL.serverFirstStarted,
    ])
  }, 30_000)

  test('the first wake is the account’s, once, and leaves a question to ask', async () => {
    const owner = await h.user()
    const created = await running(owner)
    await sent(owner.userId)
    for (let i = 0; i < 2; i++) {
      await stopped(owner, created.id)
      await h.app.edge.wake(`${created.slug}.play.test`)
      await h.until(created.id, 'running')
      await h.settled(created.id)
    }
    expect((await sent(owner.userId)).map((e) => e.event)).toEqual([FUNNEL.firstWake])
    const asks = await h.db
      .select()
      .from(schema.insightAsks)
      .where(eq(schema.insightAsks.userId, owner.userId))
    expect(asks).toMatchObject([{ moment: FUNNEL.firstWake, detail: { serverName: 'Test server' } }])
  }, 30_000)

  test('a friend joining is the second name the account’s servers have seen, once', async () => {
    const owner = await h.user()
    const { id } = await running(owner)
    await sent(owner.userId)
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Steve' })
    await h.app.schedules.presenceSync()
    expect(await sent(owner.userId)).toEqual([])
    // The same person again, under another case, is still the owner.
    h.minecraft.join(id, { uuid: randomUUID(), name: 'steve' })
    await h.app.schedules.presenceSync()
    expect(await sent(owner.userId)).toEqual([])
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Sam' })
    await h.app.schedules.presenceSync()
    expect((await sent(owner.userId)).map((e) => e.event)).toEqual([FUNNEL.firstFriendJoined])
    const [ask] = await h.db
      .select()
      .from(schema.insightAsks)
      .where(
        and(
          eq(schema.insightAsks.userId, owner.userId),
          eq(schema.insightAsks.moment, FUNNEL.firstFriendJoined),
        ),
      )
    expect(ask?.detail).toEqual({ serverName: 'Test server', player: 'Alex' })
  }, 30_000)

  test('a second calendar week of play is noticed once', async () => {
    const owner = await h.user()
    const { id } = await running(owner)
    const uuid = randomUUID()
    h.minecraft.join(id, { uuid, name: 'Steve' })
    await h.app.schedules.presenceSync()
    expect((await sent(owner.userId)).map((e) => e.event)).not.toContain(FUNNEL.firstWeek)
    // Play a week before today's is on the record too.
    await h.db.insert(schema.serverUsageDays).values({
      serverId: id,
      day: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
      provider: 'fake',
      playerMinutes: 30,
      activeMinutes: 30,
      peakPlayers: 1,
      lastSampleAt: new Date(Date.now() - 7 * 86_400_000),
    })
    await h.app.schedules.presenceSync()
    await h.app.schedules.presenceSync()
    expect((await sent(owner.userId)).map((e) => e.event)).toEqual([FUNNEL.firstWeek])
  }, 30_000)
})

describe.skipIf(!hasDatabase)('feedback', () => {
  test('goes to the Feedback survey, from the account, with what the app attached', async () => {
    const owner = await h.user('Steve', 'plus')
    const before = posthog.events.length
    expect(await h.app.insight.feedback(owner, { text: 'The world map is lovely', ...WHERE })).toEqual({
      sent: true,
    })
    const [event] = posthog.events.slice(before)
    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.id, owner.userId))
    expect(event).toEqual({
      distinctId: owner.userId,
      event: 'survey sent',
      properties: {
        $survey_id: FEEDBACK_SURVEY.id,
        $survey_name: 'Feedback',
        [`$survey_response_${FEEDBACK_SURVEY.question.id}`]: 'The world map is lovely',
        $survey_questions: [
          {
            id: FEEDBACK_SURVEY.question.id,
            question: FEEDBACK_SURVEY.question.text,
            response: 'The world map is lovely',
          },
        ],
        $survey_completed: true,
        email: user?.email,
        plan: 'plus',
        page: '/servers',
        app_version: 'test-build',
      },
    })
    // The count keeps that it was sent, never what it said.
    const audited = await h.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actor, `user:${owner.userId}`),
          eq(schema.auditLog.action, 'insight.feedback_sent'),
        ),
      )
    expect(audited.map((row) => row.data)).toEqual([{}])
  })

  test('is paced per account, three a minute', async () => {
    const owner = await h.user()
    for (let i = 0; i < 3; i++) await h.app.insight.feedback(owner, { text: `line ${i}`, ...WHERE })
    const refused = await h.app.insight.feedback(owner, { text: 'one more', ...WHERE }).catch((e) => e.code)
    expect(refused).toBe('rate_limited')
    // Someone else is counted on their own.
    expect(await h.app.insight.feedback(await h.user(), { text: 'hello', ...WHERE })).toEqual({
      sent: true,
    })
  })

  test('says so when PostHog could not take it', async () => {
    posthog.reachable = false
    expect(await h.app.insight.feedback(await h.user(), { text: 'hello', ...WHERE })).toEqual({
      sent: false,
    })
  })
})

describe.skipIf(!hasDatabase)('the good-moment question', () => {
  test('is asked once, says what it noticed, and is answered to the Good moment survey', async () => {
    const owner = await withMoment(FUNNEL.firstFriendJoined)
    const before = posthog.events.length
    const ask = await h.app.insight.ask(owner, false)
    expect(ask).toMatchObject({ moment: FUNNEL.firstFriendJoined, serverName: 'Castle', player: 'Alex' })
    // Shown again on the next page that day, without being counted as shown again.
    expect(await h.app.insight.ask(owner, false)).toEqual(ask)
    expect(posthog.events.slice(before).map((e) => e.event)).toEqual(['survey shown'])
    expect(
      await h.app.insight.answer(owner, {
        moment: FUNNEL.firstFriendJoined,
        rating: 'Good',
        text: 'We built a castle',
        ...WHERE,
      }),
    ).toEqual({ sent: true })
    const answer = posthog.events.at(-1)
    expect(answer).toMatchObject({
      distinctId: owner.userId,
      event: 'survey sent',
      properties: {
        $survey_id: MOMENT_SURVEY.id,
        [`$survey_response_${MOMENT_SURVEY.rating.id}`]: 'Good',
        [`$survey_response_${MOMENT_SURVEY.more.id}`]: 'We built a castle',
        moment: FUNNEL.firstFriendJoined,
      },
    })
    expect(await h.app.insight.ask(owner, false)).toBeNull()
    // Answered once: a second answer sends nothing.
    expect(
      await h.app.insight.answer(owner, {
        moment: FUNNEL.firstFriendJoined,
        rating: 'Not great',
        ...WHERE,
      }),
    ).toEqual({ sent: false })
  })

  test('at most once a fortnight, about a moment no older than that', async () => {
    const owner = await withMoment(FUNNEL.firstWake, 1)
    await withMoment(FUNNEL.firstFriendJoined, 0, owner)
    expect((await h.app.insight.ask(owner, false))?.moment).toBe(FUNNEL.firstFriendJoined)
    await h.app.insight.answer(owner, { moment: FUNNEL.firstFriendJoined, rating: 'Good', ...WHERE })
    // The wake is still open, but a question was asked this fortnight.
    expect(await h.app.insight.ask(owner, false)).toBeNull()
    await h.db
      .update(schema.insightAsks)
      .set({ shownAt: new Date(Date.now() - 15 * 86_400_000) })
      .where(
        and(
          eq(schema.insightAsks.userId, owner.userId),
          eq(schema.insightAsks.moment, FUNNEL.firstFriendJoined),
        ),
      )
    expect((await h.app.insight.ask(owner, false))?.moment).toBe(FUNNEL.firstWake)
    // A moment past a fortnight old is let go.
    expect(await h.app.insight.ask(await withMoment(FUNNEL.firstWeek, 15), false)).toBeNull()
  })

  test('put away, that moment is never asked about again', async () => {
    const owner = await withMoment(FUNNEL.firstWeek)
    await h.app.insight.ask(owner, false)
    const before = posthog.events.length
    await h.app.insight.dismiss(owner, FUNNEL.firstWeek)
    await h.app.insight.dismiss(owner, FUNNEL.firstWeek)
    expect(posthog.events.slice(before)).toEqual([
      {
        distinctId: owner.userId,
        event: 'survey dismissed',
        properties: { $survey_id: MOMENT_SURVEY.id, $survey_name: 'Good moment', moment: FUNNEL.firstWeek },
      },
    ])
    await h.db
      .update(schema.insightAsks)
      .set({ shownAt: new Date(Date.now() - 15 * 86_400_000) })
      .where(eq(schema.insightAsks.userId, owner.userId))
    expect(await h.app.insight.ask(owner, false)).toBeNull()
    expect(await h.app.insight.answer(owner, { moment: FUNNEL.firstWeek, rating: 'Good', ...WHERE })).toEqual(
      { sent: false },
    )
  })

  test('never while someone is making a server or paying', async () => {
    const owner = await withMoment(FUNNEL.firstWake)
    // The page says so: the create flow, or the checkout.
    expect(await h.app.insight.ask(owner, true)).toBeNull()
    // A checkout started within the hour, wherever they are now.
    await h.db.insert(schema.auditLog).values({
      actor: `user:${owner.userId}`,
      action: 'billing.checkout_started',
      subjectType: 'account',
      subjectId: owner.userId,
      data: { plan: 'plus' },
    })
    expect(await h.app.insight.ask(owner, false)).toBeNull()
    // Paid: the plan changed after it, so they are not in the middle of paying any more.
    await h.db.insert(schema.auditLog).values({
      actor: 'system:billing',
      action: 'account.plan_changed',
      subjectType: 'account',
      subjectId: owner.userId,
      data: { from: 'free', to: 'plus' },
    })
    expect((await h.app.insight.ask(owner, false))?.moment).toBe(FUNNEL.firstWake)
    // A server of theirs still being made.
    const created = await h.create(owner)
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'provisioning' })
      .where(eq(schema.minecraftServers.id, created.id))
    expect(await h.app.insight.ask(owner, false)).toBeNull()
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stopped' })
      .where(eq(schema.minecraftServers.id, created.id))
    expect((await h.app.insight.ask(owner, false))?.moment).toBe(FUNNEL.firstWake)
  }, 30_000)
})

// With no token, a deployment keeps its funnel to itself and sends nothing.
describe.skipIf(!hasDatabase)('insight with no PostHog', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('nothing is sent, asked or reported, and every request works as before', async () => {
    const owner = await h.user()
    await h.app.accounts.opened(owner.userId)
    expect(await h.app.insight.drain()).toBe(0)
    expect(await h.app.insight.feedback(owner, { text: 'hello', ...WHERE })).toEqual({ sent: false })
    await h.db.insert(schema.insightAsks).values({
      userId: owner.userId,
      moment: FUNNEL.firstWake,
      detail: { serverName: 'Castle' },
      at: new Date(),
    })
    expect(await h.app.insight.ask(owner, false)).toBeNull()
    expect(await h.app.insight.answer(owner, { moment: FUNNEL.firstWake, rating: 'Good', ...WHERE })).toEqual(
      { sent: false },
    )
  })
})
