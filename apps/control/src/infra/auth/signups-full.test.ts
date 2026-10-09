/**
 * The free-account cap (docs/money-guards.md), through the real Better Auth asking the real
 * account service: the last place is taken and the next sign-up refused, by email and by a
 * provider, with nothing written; two at once at the last place get one account; the owner always
 * gets in; which accounts take a place; and the waitlist offered instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SIGNUPS_FULL, TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import {
  countFreeAccounts,
  countTakenFreePlaces,
  ensureStanding,
  grantAdmin,
} from '../../app/accounts/persistence.ts'
import { AccountService } from '../../app/accounts/service.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail } from '../../testing/outbox.ts'
import { authHandler, createAuth } from './better-auth.ts'

const ORIGIN = 'https://blockly.test'
const API = 'http://api.internal:4000'
const OWNER = 'owner@cubepals.test'
/** The Terms every sign-up page sends with a new account. */
const AGREEMENT = { terms: TERMS_VERSION }

let h: Harness
let handle: (request: Request) => Promise<Response>
const realFetch = globalThis.fetch
/** The GitHub account the stand-ins answer for. */
let github = { id: 0, email: '' }
/** GitHub's three endpoints, as `github-sign-in.test.ts` stands them in. */
const GITHUB: Record<string, () => Response> = {
  'https://github.com/login/oauth/access_token': () =>
    Response.json({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' }),
  'https://api.github.com/user': () =>
    Response.json({ id: github.id, login: `octo-${github.id}`, name: 'Octo', email: null }),
  'https://api.github.com/user/emails': () =>
    Response.json([{ email: github.email, primary: true, verified: true, visibility: 'private' }]),
}

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness({ adminEmails: [OWNER] })
  handle = authHandler(
    createAuth({
      clientAddressHeader: 'x-blockly-client-address',
      db: h.db,
      ...authMail(),
      canonicalOrigin: ORIGIN,
      trustedOrigins: [],
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      cookiePrefix: 'blockly-test',
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
      google: null,
      oauthProxy: null,
      admitAccount: (email) => h.app.accounts.admits(email),
      onAccountCreated: (userId) => ensureStanding(h.db, userId),
    }),
  )
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return GITHUB[url]?.() ?? realFetch(input, init)
  }) as typeof fetch
}, 30_000)

afterAll(async () => {
  globalThis.fetch = realFetch
  if (hasDatabase) await h.close()
})

/** The cap set so that `room` more free accounts fit, counting places held by sign-ups in flight. */
const leaveRoomFor = async (room: number) => {
  const free = await countTakenFreePlaces(h.db)
  await h.db.update(schema.platformControls).set({ maxFreeAccounts: free + room })
}
const signUp = (email: string) =>
  handle(
    new Request(`${API}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password', name: '', agreement: AGREEMENT }),
    }),
  )
const accountFor = async (email: string) =>
  (await h.db.select().from(schema.users).where(eq(schema.users.email, email))).length
const address = () => `p-${randomUUID().slice(0, 8)}@example.test`
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

describe.skipIf(!hasDatabase)('sign-up past the free-account cap', () => {
  beforeEach(() => leaveRoomFor(0))

  test('the last place is taken, and the next sign-up is refused with nothing written', async () => {
    await leaveRoomFor(1)
    const last = address()
    expect((await signUp(last)).status).toBe(200)
    expect(await accountFor(last)).toBe(1)
    expect(await h.app.accounts.signupsOpen()).toBe(false)

    const next = address()
    const refused = await signUp(next)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: SIGNUPS_FULL })
    expect(await accountFor(next)).toBe(0)

    // An admin raises the cap on the platform page: the same address gets in.
    await leaveRoomFor(1)
    expect((await signUp(next)).status).toBe(200)
  })

  test('two sign-ups at once for the last place: exactly one gets it', async () => {
    await leaveRoomFor(1)
    const [a, b] = [address(), address()]
    const statuses = (await Promise.all([signUp(a), signUp(b)])).map((r) => r.status).sort()
    expect(statuses).toEqual([200, 403])
    expect((await accountFor(a)) + (await accountFor(b))).toBe(1)
  })

  test('the check and the take are one step: of two asked at once, one is admitted', async () => {
    await leaveRoomFor(1)
    const admitted = await Promise.all([h.app.accounts.admits(address()), h.app.accounts.admits(address())])
    expect(admitted.filter(Boolean)).toHaveLength(1)
  })

  test('a place held by a sign-up that never finished comes free when the hold ends', async () => {
    await leaveRoomFor(1)
    const unfinished = address()
    expect(await h.app.accounts.admits(unfinished)).toBe(true)
    expect(await h.app.accounts.signupsOpen()).toBe(false)
    await h.db
      .update(schema.signupHolds)
      .set({ heldUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.signupHolds.email, unfinished))
    expect(await h.app.accounts.signupsOpen()).toBe(true)
  })

  test('the owner, as ADMIN_EMAILS lists them, can always make their account', async () => {
    expect(await h.app.accounts.signupsOpen()).toBe(false)
    expect((await signUp(OWNER)).status).toBe(200)
    // And takes no place doing it.
    expect(await h.db.select().from(schema.signupHolds).where(eq(schema.signupHolds.email, OWNER))).toEqual(
      [],
    )
  })

  test('a provider sign-up past the cap makes no account, and comes back marked full', async () => {
    github = { id: Math.floor(Math.random() * 1e9), email: address() }
    const start = await handle(
      new Request(`${API}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          callbackURL: '/servers',
          errorCallbackURL: '/sign-up?via=github',
          additionalData: { agreement: AGREEMENT },
        }),
      }),
    )
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')
    const back = await handle(
      new Request(`${API}/api/auth/callback/github?code=granted&state=${state}`, {
        headers: { cookie: cookieOf(start) },
      }),
    )
    expect(back.status).toBe(302)
    const location = new URL(back.headers.get('location') ?? '', ORIGIN)
    expect(location.pathname).toBe('/sign-up')
    expect(location.searchParams.get('via')).toBe('github')
    expect(location.searchParams.get('error')).toBe(SIGNUPS_FULL)
    expect(back.headers.getSetCookie().some((c) => c.includes('session_token='))).toBe(false)
    expect(await accountFor(github.email)).toBe(0)
  })
})

describe.skipIf(!hasDatabase)('who takes a free place, and the waitlist', () => {
  test('paying, closed and admin accounts take no free place', async () => {
    const before = await countFreeAccounts(h.db)
    const [paying, closed, admin] = [await h.user(), await h.user(), await h.user()]
    expect(await countFreeAccounts(h.db)).toBe(before + 3)
    await h.db.insert(schema.billingSubscriptions).values({
      userId: paying.userId,
      provider: 'polar',
      externalCustomerId: 'cus_1',
      externalSubscriptionId: 'sub_1',
      planKey: 'plus',
      status: 'active',
    })
    await h.db
      .update(schema.accountStanding)
      .set({ status: 'terminated' })
      .where(eq(schema.accountStanding.userId, closed.userId))
    await grantAdmin(h.db, admin.userId, 'config')
    expect(await countFreeAccounts(h.db)).toBe(before)
  })

  test('the waitlist keeps an address once, lowercased, with the link that brought it', async () => {
    await h.app.accounts.joinWaitlist('Later@Example.test', 'reddit')
    await h.app.accounts.joinWaitlist('later@example.test', 'tiktok')
    const kept = await h.db
      .select()
      .from(schema.waitlist)
      .where(eq(schema.waitlist.email, 'later@example.test'))
    expect(kept).toEqual([expect.objectContaining({ email: 'later@example.test', source: 'reddit' })])
  })

  test('the waitlist slows a flood rather than taking every address a script sends', async () => {
    const now = Date.now() + 120_000
    for (let i = 0; i < 30; i++) await h.app.accounts.joinWaitlist(`flood-${i}@example.test`, null, now)
    await expect(h.app.accounts.joinWaitlist('one-more@example.test', null, now)).rejects.toMatchObject({
      code: 'rate_limited',
    })
    // A minute later there's room again.
    await h.app.accounts.joinWaitlist('one-more@example.test', null, now + 60_001)
  })
})

describe.skipIf(!hasDatabase)('sign-up in local development', () => {
  test('has no cap: a full platform still makes the account', async () => {
    await leaveRoomFor(0)
    const local = new AccountService({
      db: h.db,
      servers: h.app.servers,
      jobs: h.jobs,
      mailer: h.mail,
      webOrigin: 'http://localhost:3000',
      configured: { admins: [], signupCap: false },
    })
    const handleLocally = authHandler(
      createAuth({
        clientAddressHeader: 'x-blockly-client-address',
        db: h.db,
        ...authMail(),
        canonicalOrigin: ORIGIN,
        trustedOrigins: [],
        secret: 'a-test-secret-that-is-long-enough-for-better-auth',
        cookiePrefix: 'blockly-test',
        github: null,
        google: null,
        oauthProxy: null,
        admitAccount: (email) => local.admits(email),
        onAccountCreated: (userId) => ensureStanding(h.db, userId),
      }),
    )
    expect(await h.app.accounts.signupsOpen()).toBe(false)
    expect(await local.signupsOpen()).toBe(true)
    const email = address()
    const made = await handleLocally(
      new Request(`${API}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'a-long-enough-password', name: '', agreement: AGREEMENT }),
      }),
    )
    expect(made.status).toBe(200)
    expect(await accountFor(email)).toBe(1)
  })
})
