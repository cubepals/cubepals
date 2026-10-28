// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Confirming an email, through the real Better Auth asking the real account service: the browser
 * that confirms is the one left signed in, every earlier session of the account ends, and an
 * address ADMIN_EMAILS lists becomes an admin only then, signed in only where that happened.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { ensureStanding, isAdmin } from '../../app/accounts/persistence.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail, Outbox } from '../../testing/outbox.ts'
import { type Auth, createAuth } from './better-auth.ts'

const ORIGIN = 'http://localhost:3000'
const OWNER = `owner-${randomUUID().slice(0, 8)}@cubepals.test`
/** Listed too, with an account confirmed before the list named it. */
const LISTED_LATER = `later-${randomUUID().slice(0, 8)}@cubepals.test`
const PASSWORD = 'a-long-enough-password'

let h: Harness
let auth: Auth
const outbox = new Outbox()

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness({ adminEmails: [OWNER, LISTED_LATER] })
  auth = createAuth({
    clientAddressHeader: 'x-blockly-client-address',
    db: h.db,
    ...authMail(outbox),
    canonicalOrigin: ORIGIN,
    trustedOrigins: [],
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    cookiePrefix: 'blockly-test',
    github: null,
    google: null,
    oauthProxy: null,
    onAccountCreated: (userId) => ensureStanding(h.db, userId),
    onAccount: (user, keep) => h.app.accounts.configuredAdmin(user, keep),
  })
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

const call = (path: string, init: { body?: unknown; cookie?: string } = {}) =>
  auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        origin: ORIGIN,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'manual',
    }),
  )
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
const signedIn = async (cookie: string) =>
  ((await (await call('/get-session', { cookie })).json()) as { user: { emailVerified: boolean } } | null)
    ?.user ?? null
/** A sign-up as the page sends it, and a second sign-in to the same account elsewhere. */
const signUp = async (email: string) => {
  const made = await call('/sign-up/email', {
    body: { email, password: PASSWORD, name: '', agreement: { terms: TERMS_VERSION } },
  })
  expect(made.status).toBe(200)
  const elsewhere = await call('/sign-in/email', { body: { email, password: PASSWORD } })
  expect(elsewhere.status).toBe(200)
  return { first: cookieOf(made), second: cookieOf(elsewhere) }
}
/** The emailed link, followed in a browser holding `cookie`, or in a fresh one. */
const follow = async (link: string, cookie?: string) => {
  const response = await auth.handler(
    new Request(link, { headers: cookie ? { cookie } : {}, redirect: 'manual' }),
  )
  expect(response.status).toBe(302)
  return cookieOf(response) || (cookie ?? '')
}
const confirm = (email: string, cookie?: string) => follow(outbox.link(email), cookie)
const userId = async (email: string) =>
  (await h.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]
    ?.id ?? ''

describe.skipIf(!hasDatabase)('confirming an email', () => {
  test('from another browser: that browser is signed in, and every earlier session ends', async () => {
    const email = `confirm-${randomUUID().slice(0, 8)}@example.test`
    const { first, second } = await signUp(email)
    expect(await signedIn(first)).toMatchObject({ emailVerified: false })

    const confirmed = await confirm(email)
    expect(await signedIn(confirmed)).toMatchObject({ emailVerified: true })
    expect(await signedIn(first)).toBeNull()
    expect(await signedIn(second)).toBeNull()
    const sessions = await h.db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, await userId(email)))
    expect(sessions).toHaveLength(1)
  })

  test('in the browser that signed up: it stays signed in, and only it', async () => {
    const email = `confirm-${randomUUID().slice(0, 8)}@example.test`
    const { first, second } = await signUp(email)

    const link = outbox.link(email)
    const confirmed = await follow(link, first)
    expect(await signedIn(confirmed)).toMatchObject({ emailVerified: true })
    expect(await signedIn(first)).toMatchObject({ emailVerified: true })
    expect(await signedIn(second)).toBeNull()

    // The link followed again changes nothing: the confirmed account keeps its session.
    await follow(link, first)
    expect(await signedIn(first)).toMatchObject({ emailVerified: true })
  })

  test('an address ADMIN_EMAILS lists is an admin only once confirmed, and only where it confirmed', async () => {
    const { first, second } = await signUp(OWNER)
    const id = await userId(OWNER)
    expect(await isAdmin(h.db, id)).toBe(false)

    const confirmed = await confirm(OWNER)
    expect(await isAdmin(h.db, id)).toBe(true)
    expect(await signedIn(confirmed)).toMatchObject({ emailVerified: true })
    expect(await signedIn(first)).toBeNull()
    expect(await signedIn(second)).toBeNull()
  })
})

describe.skipIf(!hasDatabase)('admins ADMIN_EMAILS names at start', () => {
  test('a confirmed account the list names at start becomes an admin, and signs in again', async () => {
    const id = randomUUID()
    await h.db.insert(schema.users).values({ id, name: '', email: LISTED_LATER, emailVerified: true })
    const session = {
      id: randomUUID(),
      token: randomUUID(),
      userId: id,
      expiresAt: new Date(Date.now() + HOUR_MS),
    }
    await h.db.insert(schema.authSessions).values(session)

    await h.app.accounts.bootstrapAdmins()
    expect(await isAdmin(h.db, id)).toBe(true)
    expect(await h.db.select().from(schema.authSessions).where(eq(schema.authSessions.userId, id))).toEqual(
      [],
    )
  })
})
